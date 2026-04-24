from datetime import datetime
import json
from pathlib import Path
import sys
import time

from xr_agent.config import AppConfig
from xr_agent.coding_sessions import CodingSessionTool, ManagedCodingSessionManager
from xr_agent.hermes_runtime import HermesPromptResult
from xr_agent.main import build_app
from xr_agent.models import Session, SessionStatus


def test_what_happened_returns_last_summary(tmp_path) -> None:
    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    session = Session(
        session_id="done-1",
        title="Run tests",
        repo_path=str(tmp_path),
        command="python3 -m pytest -q",
        status=SessionStatus.FINISHED,
        started_at=datetime.now(),
        finished_at=datetime.now(),
        exit_code=0,
        summary="Run tests finished successfully.",
    )
    app.store.update(session)

    response = app.handle_text("what happened?", repo_path=str(tmp_path))

    assert response["message"] == "Run tests finished successfully."


def test_rerun_last_replays_previous_command(tmp_path) -> None:
    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    session = Session(
        session_id="done-2",
        title="Quick run",
        repo_path=str(tmp_path),
        command="/bin/sh -c 'printf \"reran\\n\"'",
        status=SessionStatus.FINISHED,
        started_at=datetime.now(),
        finished_at=datetime.now(),
        exit_code=0,
        summary="ok",
    )
    app.store.update(session)

    response = app.handle_text("rerun it", repo_path=str(tmp_path))
    completed = app.wait_for_session(response["session_id"], timeout=5)

    assert completed is not None
    assert completed.exit_code == 0
    assert "reran" in completed.output_tail


def test_fix_and_rerun_uses_persistent_hermes_runtime_and_records_summary(tmp_path) -> None:
    shared_root = Path(__file__).resolve().parents[3] / "shared" / "prompts"
    assert (shared_root / "followup_prompt.md").exists()

    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    app.hermes_runtime = FakeHermesRuntime("I fixed it and reran the checks.")
    session = Session(
        session_id="done-3",
        title="Broken tests",
        repo_path=str(tmp_path),
        command="python3 -m pytest -q",
        status=SessionStatus.FAILED,
        started_at=datetime.now(),
        finished_at=datetime.now(),
        exit_code=1,
        output_tail=["AssertionError: boom"],
        summary="Broken tests failed.",
    )
    app.store.update(session)

    response = app.handle_text("fix that and rerun", repo_path=str(tmp_path))
    assert response["message"] == "I fixed it and reran the checks."
    assert app.hermes_runtime.calls[0]["repo_path"] == str(tmp_path)
    assert "You are Hermes" in app.hermes_runtime.calls[0]["prompt"]
    completed = app.store.last_completed()
    assert completed is not None
    assert completed.summary == "I fixed it and reran the checks."


def test_build_command_uses_repo_aware_command_resolution_for_node_projects(tmp_path) -> None:
    (tmp_path / "package.json").write_text(
        '{"name":"demo","scripts":{"build":"node build.js"}}',
        encoding="utf-8",
    )
    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))

    response = app.handle_text("build", repo_path=str(tmp_path))
    completed = app.wait_for_session(response["session_id"], timeout=5)

    assert completed is not None
    assert completed.command == "npm run build"


def test_generic_followup_prefers_explicit_repo_over_last_completed_session(tmp_path) -> None:
    primary_repo = tmp_path / "primary"
    other_repo = tmp_path / "other"
    primary_repo.mkdir()
    other_repo.mkdir()

    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    app.hermes_runtime = FakeHermesRuntime("I cleaned it up in the original repo.")
    session = Session(
        session_id="done-4",
        title="Broken tests",
        repo_path=str(primary_repo),
        command="python3 -m pytest -q",
        status=SessionStatus.FAILED,
        started_at=datetime.now(),
        finished_at=datetime.now(),
        exit_code=1,
        output_tail=["AssertionError: boom"],
        summary="Broken tests failed.",
    )
    app.store.update(session)

    response = app.handle_text("okay now clean that up", repo_path=str(other_repo))
    assert response["message"] == "I cleaned it up in the original repo."
    assert app.hermes_runtime.calls[0]["repo_path"] == str(other_repo)


def test_existing_failure_summary_is_preserved(tmp_path) -> None:
    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    session = Session(
        session_id="done-5",
        title="Broken launch",
        repo_path=str(tmp_path),
        command="missing-command",
        status=SessionStatus.FAILED,
        started_at=datetime.now(),
        finished_at=datetime.now(),
        exit_code=1,
        summary="Failed to start: missing-command",
    )

    app._on_session_finished(session)

    updated = app.store.get("done-5")
    assert updated is not None
    assert updated.summary == "Failed to start: missing-command"


def test_what_happened_prefers_clean_hermes_reply_over_stats(tmp_path) -> None:
    app = build_app(AppConfig(hermes_cmd="hermes", state_dir=tmp_path / "state"))
    hermes_session = Session(
        session_id="done-hermes",
        title="Hermes follow-up",
        repo_path=str(tmp_path),
        command="hermes chat --quiet -q hello",
        status=SessionStatus.FINISHED,
        started_at=datetime.now(),
        finished_at=datetime.now(),
        exit_code=0,
        output_tail=[
            "⚠️  API call failed (attempt 1/3): APIError",
            "Hello, Bless.",
            "",
            "session_id: 20260318_015050_1b080a",
        ],
        summary="Hermes follow-up finished successfully with exit code 0. Last output: Messages: 22",
    )
    app.store.update(hermes_session)

    response = app.handle_text("what happened", repo_path=str(tmp_path))

    assert response["message"] == "Hello, Bless."


def test_summarize_coding_session_uses_persistent_hermes_runtime(tmp_path) -> None:
    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    app.hermes_runtime = FakeHermesRuntime("Claude is editing auth tests and is not blocked.")
    app.coding_sessions = ManagedCodingSessionManager(
        tools={
            "open_claude_code": CodingSessionTool(
                intent="open_claude_code",
                title="Claude Code",
                argv=(sys.executable, "-i", "-q"),
            )
        }
    )

    app.handle_text("open claude here", repo_path=str(tmp_path))
    session = _wait_for_coding_session(app, "open_claude_code")
    assert session is not None
    app.handle_text("tell claude print('working')", repo_path=str(tmp_path))
    _wait_for(
        lambda: any(
            "working" in line
            for line in (app.coding_sessions.get(session.session_id).output_tail or [])
        ),
        timeout=5,
    )

    response = app.handle_text("what is claude doing", repo_path=str(tmp_path))

    assert response["message"] == "Claude is editing auth tests and is not blocked."
    assert "Recent terminal output:" in app.hermes_runtime.calls[0]["prompt"]
    app.coding_sessions.shutdown()


def test_open_claude_session_and_send_followup(tmp_path) -> None:
    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    app.coding_sessions = ManagedCodingSessionManager(
        tools={
            "open_claude_code": CodingSessionTool(
                intent="open_claude_code",
                title="Claude Code",
                argv=(sys.executable, "-i", "-q"),
            )
        }
    )

    open_response = app.handle_text("open claude here", repo_path=str(tmp_path))
    assert open_response["message"] == "Okay, opened Claude Code in this project."
    assert open_response["intent"] == "open_claude_code"
    assert open_response["title"] == "Claude Code"
    assert open_response["repo_path"] == str(tmp_path)
    assert open_response["status"] == SessionStatus.RUNNING.value
    assert open_response["session_id"].startswith("term_")
    assert isinstance(open_response["pid"], int)

    session = _wait_for_coding_session(app, "open_claude_code")
    assert session is not None
    assert session.session_id == open_response["session_id"]

    send_response = app.handle_text("tell claude print('hello from headset')", repo_path=str(tmp_path))
    assert send_response["message"] == "Sent that to Claude Code."

    _wait_for(
        lambda: any(
            "hello from headset" in line
            for line in (app.coding_sessions.get(session.session_id).output_tail or [])
        ),
        timeout=5,
    )

    app.handle_text("tell claude raise SystemExit", repo_path=str(tmp_path))
    _wait_for(
        lambda: app.coding_sessions.get(session.session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
        timeout=5,
    )
    app.coding_sessions.shutdown()


def test_send_and_close_claude_prefer_matching_repo_over_newer_open_session(tmp_path) -> None:
    repo_a = tmp_path / "repo-a"
    repo_b = tmp_path / "repo-b"
    repo_a.mkdir()
    repo_b.mkdir()

    claude_launcher = tmp_path / "fake_claude_repo_routing.py"
    claude_launcher.write_text(
        "\n".join(
            [
                "import sys",
                "print('Claude ready', flush=True)",
                "for line in sys.stdin:",
                "    text = line.rstrip('\\n')",
                "    if text == 'exit':",
                "        break",
                "    print(f'CLAUDE RECEIVED: {text}', flush=True)",
            ]
        ),
        encoding="utf-8",
    )

    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    app.coding_sessions = ManagedCodingSessionManager(
        tools={
            "open_claude_code": CodingSessionTool(
                intent="open_claude_code",
                title="Claude Code",
                argv=(sys.executable, str(claude_launcher)),
            )
        }
    )

    app.handle_text("open claude here", repo_path=str(repo_a))
    session_a = _wait_for_coding_session(app, "open_claude_code")
    assert session_a is not None
    assert session_a.repo_path == str(repo_a)

    app.handle_text("open claude here", repo_path=str(repo_b))
    _wait_for(
        lambda: any(
            session.intent == "open_claude_code" and session.repo_path == str(repo_b)
            for session in app.coding_sessions.list_sessions()
        ),
        timeout=5,
    )
    session_b = next(
        session
        for session in app.coding_sessions.list_sessions()
        if session.intent == "open_claude_code" and session.repo_path == str(repo_b)
    )

    response = app.handle_text("tell claude review the auth bug", repo_path=str(repo_a))
    assert response["message"] == "Sent that to Claude Code."
    _wait_for(
        lambda: any(
            "CLAUDE RECEIVED: review the auth bug" in line
            for line in (app.coding_sessions.get(session_a.session_id).output_tail or [])
        ),
        timeout=5,
    )
    assert not any(
        "CLAUDE RECEIVED: review the auth bug" in line
        for line in (app.coding_sessions.get(session_b.session_id).output_tail or [])
    )

    close_response = app.handle_text("close claude", repo_path=str(repo_a))
    assert close_response["message"] == "Okay, closing Claude Code."
    _wait_for(
        lambda: app.coding_sessions.get(session_a.session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
        timeout=5,
    )
    assert app.coding_sessions.get(session_b.session_id).status == SessionStatus.RUNNING

    app.handle_text("tell claude exit", repo_path=str(repo_b))
    _wait_for(
        lambda: app.coding_sessions.get(session_b.session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
        timeout=5,
    )
    app.coding_sessions.shutdown()


def test_ui_style_followup_uses_main_hermes_runtime_over_active_claude(tmp_path) -> None:
    claude_launcher = tmp_path / "fake_claude.py"
    claude_launcher.write_text(
        "\n".join(
            [
                "import sys",
                "print('Claude ready', flush=True)",
                "for line in sys.stdin:",
                "    text = line.rstrip('\\n')",
                "    if text == 'exit':",
                "        break",
                "    print(f'CLAUDE RECEIVED: {text}', flush=True)",
            ]
        ),
        encoding="utf-8",
    )

    app = build_app(AppConfig(hermes_cmd="hermes", state_dir=tmp_path / "state"))
    app.hermes_runtime = FakeHermesRuntime("I handled that in the main Hermes runtime.")
    app.coding_sessions = ManagedCodingSessionManager(
        tools={
            "open_claude_code": CodingSessionTool(
                intent="open_claude_code",
                title="Claude Code",
                argv=(sys.executable, str(claude_launcher)),
            ),
            "open_hermes_cli": CodingSessionTool(
                intent="open_hermes_cli",
                title="Hermes CLI",
                argv=(sys.executable, "-i", "-q"),
            ),
        }
    )

    app.handle_text("open claude here", repo_path=str(tmp_path))
    claude_session = _wait_for_coding_session(app, "open_claude_code")
    assert claude_session is not None

    response = app.handle_text("approve it", repo_path=str(tmp_path))

    assert response["message"] == "I handled that in the main Hermes runtime."
    assert app.hermes_runtime.calls[0]["repo_path"] == str(tmp_path)
    assert app.coding_sessions.latest_session(intent="open_hermes_cli") is None
    assert not any(
        "CLAUDE RECEIVED: approve it" in line
        for line in (app.coding_sessions.get(claude_session.session_id).output_tail or [])
    )

    app.handle_text("tell claude exit", repo_path=str(tmp_path))
    _wait_for(
        lambda: app.coding_sessions.get(claude_session.session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
        timeout=5,
    )
    app.coding_sessions.shutdown()



def test_vague_followup_with_multiple_active_coding_sessions_uses_hermes_runtime(tmp_path) -> None:
    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    app.hermes_runtime = FakeHermesRuntime("I cleaned it up.")
    app.coding_sessions = ManagedCodingSessionManager(
        tools={
            "open_claude_code": CodingSessionTool(
                intent="open_claude_code",
                title="Claude Code",
                argv=(sys.executable, "-i", "-q"),
            ),
            "open_hermes_cli": CodingSessionTool(
                intent="open_hermes_cli",
                title="Hermes CLI",
                argv=(sys.executable, "-i", "-q"),
            ),
        }
    )

    app.handle_text("open claude here", repo_path=str(tmp_path))
    app.handle_text("open hermes here", repo_path=str(tmp_path))

    response = app.handle_text("keep going", repo_path=str(tmp_path))

    assert response["message"] == "I cleaned it up."
    assert app.hermes_runtime.calls[0]["repo_path"] == str(tmp_path)

    claude_session = _wait_for_coding_session(app, "open_claude_code")
    hermes_session = _wait_for_coding_session(app, "open_hermes_cli")
    assert claude_session is not None
    assert hermes_session is not None
    app.handle_text("tell claude raise SystemExit", repo_path=str(tmp_path))
    app.handle_text("tell hermes raise SystemExit", repo_path=str(tmp_path))
    _wait_for(
        lambda: app.coding_sessions.get(claude_session.session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
        timeout=5,
    )
    _wait_for(
        lambda: app.coding_sessions.get(hermes_session.session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
        timeout=5,
    )
    app.coding_sessions.shutdown()



def test_generic_followup_without_ui_language_still_uses_hermes_runtime(tmp_path) -> None:
    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    app.hermes_runtime = FakeHermesRuntime("I cleaned it up.")
    app.coding_sessions = ManagedCodingSessionManager(
        tools={
            "open_claude_code": CodingSessionTool(
                intent="open_claude_code",
                title="Claude Code",
                argv=(sys.executable, "-i", "-q"),
            )
        }
    )

    app.handle_text("open claude here", repo_path=str(tmp_path))
    response = app.handle_text("okay now clean that up", repo_path=str(tmp_path))

    assert response["message"] == "I cleaned it up."
    assert app.hermes_runtime.calls[0]["repo_path"] == str(tmp_path)
    assert "Authoritative system snapshot:" in app.hermes_runtime.calls[0]["prompt"]
    assert "Claude Code [open_claude_code]" in app.hermes_runtime.calls[0]["prompt"]

    session = _wait_for_coding_session(app, "open_claude_code")
    assert session is not None
    app.handle_text("tell claude raise SystemExit", repo_path=str(tmp_path))
    _wait_for(
        lambda: app.coding_sessions.get(session.session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
        timeout=5,
    )
    app.coding_sessions.shutdown()



def test_unresolved_claude_request_can_open_and_send_via_hermes_supervisor_json(tmp_path) -> None:
    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    app.hermes_runtime = FakeHermesRuntime(
        json.dumps(
            {
                "action": "open_and_send_to_session",
                "target": "open_claude_code",
                "repo_path": str(tmp_path),
                "content": 'print("supervised mac companion")',
                "reply_text": "I opened Claude and asked it to continue the mac companion work.",
            }
        )
    )
    app.coding_sessions = ManagedCodingSessionManager(
        tools={
            "open_claude_code": CodingSessionTool(
                intent="open_claude_code",
                title="Claude Code",
                argv=(sys.executable, "-i", "-q"),
            )
        }
    )

    response = app.handle_text("claude should continue where we left off on mac companion", repo_path=str(tmp_path))

    assert response["message"] == "I opened Claude and asked it to continue the mac companion work."
    session = _wait_for_coding_session(app, "open_claude_code")
    assert session is not None
    _wait_for(
        lambda: any(
            "supervised mac companion" in line
            for line in (app.coding_sessions.get(session.session_id).output_tail or [])
        ),
        timeout=5,
    )

    app.handle_text("tell claude raise SystemExit", repo_path=str(tmp_path))
    _wait_for(
        lambda: app.coding_sessions.get(session.session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
        timeout=5,
    )
    app.coding_sessions.shutdown()


def test_unresolved_claude_request_can_send_to_existing_session_via_hermes_supervisor_json(tmp_path) -> None:
    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    app.hermes_runtime = FakeHermesRuntime(
        json.dumps(
            {
                "action": "send_to_session",
                "target": "open_claude_code",
                "repo_path": str(tmp_path),
                "content": 'print("resume from supervisor")',
                "reply_text": "I asked Claude to pick the work back up.",
            }
        )
    )
    app.coding_sessions = ManagedCodingSessionManager(
        tools={
            "open_claude_code": CodingSessionTool(
                intent="open_claude_code",
                title="Claude Code",
                argv=(sys.executable, "-i", "-q"),
            )
        }
    )

    app.handle_text("open claude here", repo_path=str(tmp_path))
    session = _wait_for_coding_session(app, "open_claude_code")
    assert session is not None

    response = app.handle_text("claude should keep working on it", repo_path=str(tmp_path))

    assert response["message"] == "I asked Claude to pick the work back up."
    _wait_for(
        lambda: any(
            "resume from supervisor" in line
            for line in (app.coding_sessions.get(session.session_id).output_tail or [])
        ),
        timeout=5,
    )

    app.handle_text("tell claude raise SystemExit", repo_path=str(tmp_path))
    _wait_for(
        lambda: app.coding_sessions.get(session.session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
        timeout=5,
    )
    app.coding_sessions.shutdown()


def test_generic_followup_uses_main_hermes_runtime_even_when_visible_hermes_tool_exists(tmp_path) -> None:
    app = build_app(AppConfig(hermes_cmd="hermes", state_dir=tmp_path / "state"))
    app.hermes_runtime = FakeHermesRuntime("I kept using the main Hermes session.")
    app.coding_sessions = ManagedCodingSessionManager(
        tools={
            "open_hermes_cli": CodingSessionTool(
                intent="open_hermes_cli",
                title="Hermes CLI",
                argv=(sys.executable, "-i", "-q"),
            )
        }
    )

    response = app.handle_text("keep working on this task", repo_path=str(tmp_path))

    assert response["message"] == "I kept using the main Hermes session."
    assert app.hermes_runtime.calls[0]["repo_path"] == str(tmp_path)
    assert app.coding_sessions.latest_session(intent="open_hermes_cli") is None
    app.coding_sessions.shutdown()


def test_generic_followup_prefers_explicit_repo_path_over_last_completed_session(tmp_path) -> None:
    primary_repo = tmp_path / "primary"
    other_repo = tmp_path / "other"
    primary_repo.mkdir()
    other_repo.mkdir()

    app = build_app(AppConfig(hermes_cmd="hermes", state_dir=tmp_path / "state"))
    app.hermes_runtime = FakeHermesRuntime("I used the explicit repo.")
    app.store.update(
        Session(
            session_id="done-visible-hermes",
            title="Broken tests",
            repo_path=str(primary_repo),
            command="python3 -m pytest -q",
            status=SessionStatus.FAILED,
            started_at=datetime.now(),
            finished_at=datetime.now(),
            exit_code=1,
            summary="Broken tests failed.",
        )
    )
    app.coding_sessions = ManagedCodingSessionManager(
        tools={
            "open_hermes_cli": CodingSessionTool(
                intent="open_hermes_cli",
                title="Hermes CLI",
                argv=(sys.executable, "-i", "-q"),
            )
        }
    )

    response = app.handle_text("clean that up", repo_path=str(other_repo))

    assert response["message"] == "I used the explicit repo."
    assert app.hermes_runtime.calls[0]["repo_path"] == str(other_repo)
    assert app.coding_sessions.latest_session(intent="open_hermes_cli") is None
    app.coding_sessions.shutdown()


def test_explicit_worker_label_instruction_routes_to_matching_claude_worker_without_opening_hermes(tmp_path) -> None:
    claude_launcher = tmp_path / "fake_claude_worker.py"
    claude_launcher.write_text(
        "\n".join(
            [
                "import sys",
                "print('Claude ready', flush=True)",
                "for line in sys.stdin:",
                "    text = line.rstrip('\\n')",
                "    if text == 'exit':",
                "        break",
                "    print(f'CLAUDE RECEIVED: {text}', flush=True)",
            ]
        ),
        encoding="utf-8",
    )

    app = build_app(AppConfig(hermes_cmd="hermes", state_dir=tmp_path / "state"))
    app.coding_sessions = ManagedCodingSessionManager(
        tools={
            "open_claude_code": CodingSessionTool(
                intent="open_claude_code",
                title="Claude Code",
                argv=(sys.executable, str(claude_launcher)),
            ),
            "open_hermes_cli": CodingSessionTool(
                intent="open_hermes_cli",
                title="Hermes CLI",
                argv=(sys.executable, "-i", "-q"),
            ),
        }
    )

    app.handle_text("open claude here", repo_path=str(tmp_path))
    app.handle_text("open claude here", repo_path=str(tmp_path))
    app.handle_text("open claude here", repo_path=str(tmp_path))
    third_session = _wait_for_coding_session(app, "open_claude_code")
    assert third_session is not None
    _wait_for(
        lambda: any(
            state.worker_label == "Claude 3"
            for state in app._workers_by_session_id.values()
        ),
        timeout=5,
    )

    response = app.handle_text(
        "can you use claude session 3 and tell them to review the code?",
        repo_path=str(tmp_path),
    )

    assert response["message"] == "I told Claude 3 to review the code."
    assert app.coding_sessions.latest_session(intent="open_hermes_cli") is None
    _wait_for(
        lambda: any(
            "CLAUDE RECEIVED: review the code" in line
            for line in (app.coding_sessions.get(third_session.session_id).output_tail or [])
        ),
        timeout=5,
    )
    app.handle_text("tell claude exit", repo_path=str(tmp_path))
    app.handle_text("tell claude exit", repo_path=str(tmp_path))
    app.handle_text("tell claude exit", repo_path=str(tmp_path))
    app.coding_sessions.shutdown()


def test_open_claude_with_dangerous_skip_permissions_passes_flag(tmp_path) -> None:
    launcher = tmp_path / "claude_launcher.py"
    launcher.write_text(
        "\n".join(
            [
                "import pathlib",
                "import sys",
                "",
                "path = pathlib.Path(sys.argv[1])",
                "path.write_text(' '.join(sys.argv[2:]), encoding='utf-8')",
                "print('ready', flush=True)",
                "for line in sys.stdin:",
                "    if line.strip() == 'exit':",
                "        break",
            ]
        ),
        encoding="utf-8",
    )
    args_capture = tmp_path / "claude_args.txt"

    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    app.coding_sessions = ManagedCodingSessionManager(
        tools={
            "open_claude_code": CodingSessionTool(
                intent="open_claude_code",
                title="Claude Code",
                argv=(sys.executable, str(launcher), str(args_capture)),
            )
        }
    )

    open_response = app.handle_text(
        "open claude here with dangerously skip permissions",
        repo_path=str(tmp_path),
    )

    assert open_response["message"] == "Okay, opened Claude Code in this project."
    session = _wait_for_coding_session(app, "open_claude_code")
    assert session is not None
    _wait_for(lambda: args_capture.exists(), timeout=5)
    assert args_capture.read_text(encoding="utf-8").strip() == "--dangerously-skip-permissions"
    assert session.command.endswith("--dangerously-skip-permissions")
    app.handle_text("tell claude exit", repo_path=str(tmp_path))
    _wait_for(
        lambda: app.coding_sessions.get(session.session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
        timeout=5,
    )
    app.coding_sessions.shutdown()


def test_open_claude_with_dangerous_skip_permissions_auto_accepts_trust_prompt(tmp_path) -> None:
    launcher = tmp_path / "claude_trust_prompt.py"
    launcher.write_text(
        "\n".join(
            [
                "import sys",
                "",
                "print('Quick safety check', flush=True)",
                "print('Yes, I trust this folder', flush=True)",
                "print('Enter to confirm', flush=True)",
                "line = sys.stdin.readline()",
                "if line == '\\n':",
                "    print('TRUSTED AND READY', flush=True)",
                "else:",
                "    print(f'UNEXPECTED INPUT: {line!r}', flush=True)",
            ]
        ),
        encoding="utf-8",
    )

    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    app.coding_sessions = ManagedCodingSessionManager(
        tools={
            "open_claude_code": CodingSessionTool(
                intent="open_claude_code",
                title="Claude Code",
                argv=(sys.executable, str(launcher)),
            )
        }
    )

    response = app.handle_text(
        "open claude here with dangerously skip permissions",
        repo_path=str(tmp_path),
    )

    assert response["message"] == "Okay, opened Claude Code in this project."
    session = _wait_for_coding_session(app, "open_claude_code")
    assert session is not None
    _wait_for(
        lambda: any(
            "TRUSTED AND READY" in line
            for line in (app.coding_sessions.get(session.session_id).output_tail or [])
        ),
        timeout=5,
    )
    app.coding_sessions.shutdown()


def test_open_claude_auto_accepts_normal_trust_prompt_and_reports_status(tmp_path) -> None:
    launcher = tmp_path / "claude_normal_trust_prompt.py"
    launcher.write_text(
        "\n".join(
            [
                "import sys",
                "",
                "print('Quick safety check: Is this a project you created or one you trust?', flush=True)",
                "print('Yes, I trust this folder', flush=True)",
                "print('Enter to confirm', flush=True)",
                "line = sys.stdin.readline()",
                "if line == '\\n':",
                "    print('CLAUDE TRUSTED AND READY', flush=True)",
                "else:",
                "    print(f'UNEXPECTED INPUT: {line!r}', flush=True)",
            ]
        ),
        encoding="utf-8",
    )

    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    app.coding_sessions = ManagedCodingSessionManager(
        tools={
            "open_claude_code": CodingSessionTool(
                intent="open_claude_code",
                title="Claude Code",
                argv=(sys.executable, str(launcher)),
            )
        }
    )

    response = app.handle_text("open claude here", repo_path=str(tmp_path))

    assert response["message"] == "Okay, opened Claude Code in this project."
    session = _wait_for_coding_session(app, "open_claude_code")
    assert session is not None
    _wait_for(
        lambda: any(
            "CLAUDE TRUSTED AND READY" in line
            for line in (app.coding_sessions.get(session.session_id).output_tail or [])
        ),
        timeout=5,
    )

    _wait_for(
        lambda: any(
            event["type"] == "hermes.status"
            and event["session_id"] == session.session_id
            and event["payload"].get("text") == "Hermes approved Claude's trust prompt and Claude is continuing."
            for event in app.events.recent_serialized()
        ),
        timeout=5,
    )
    app.coding_sessions.shutdown()


def test_open_claude_uses_explicit_repo_path_from_transcript(tmp_path) -> None:
    target_repo = tmp_path / "target-repo"
    target_repo.mkdir()

    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    app.coding_sessions = ManagedCodingSessionManager(
        tools={
            "open_claude_code": CodingSessionTool(
                intent="open_claude_code",
                title="Claude Code",
                argv=(sys.executable, "-i", "-q"),
            )
        }
    )

    response = app.handle_text(
        f"go to {target_repo} and open claude here",
        repo_path=str(tmp_path),
    )

    assert response["message"] == "Okay, opened Claude Code in this project."
    assert response["repo_path"] == str(target_repo)
    session = _wait_for_coding_session(app, "open_claude_code")
    assert session is not None
    assert session.repo_path == str(target_repo)
    app.handle_text("tell claude raise SystemExit", repo_path=str(target_repo))
    _wait_for(
        lambda: app.coding_sessions.get(session.session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
        timeout=5,
    )
    app.coding_sessions.shutdown()


def test_open_claude_resolves_named_project_from_workspace_roots(tmp_path) -> None:
    desktop_root = tmp_path / "Desktop"
    target_repo = desktop_root / "xr-coding-agent" / "apps" / "mac-companion"
    target_repo.mkdir(parents=True)
    (target_repo / "pyproject.toml").write_text("[project]\nname='mac-companion'\n", encoding="utf-8")

    app = build_app(
        AppConfig(
            hermes_cmd="echo",
            state_dir=tmp_path / "state",
            project_search_roots=(desktop_root,),
        )
    )
    app.coding_sessions = ManagedCodingSessionManager(
        tools={
            "open_claude_code": CodingSessionTool(
                intent="open_claude_code",
                title="Claude Code",
                argv=(sys.executable, "-i", "-q"),
            )
        }
    )

    response = app.handle_text(
        "open claude in the mac companion project",
        repo_path=str(tmp_path),
    )

    assert response["message"] == "Okay, opened Claude Code in this project."
    assert response["repo_path"] == str(target_repo)
    session = _wait_for_coding_session(app, "open_claude_code")
    assert session is not None
    assert session.repo_path == str(target_repo)
    app.handle_text("tell claude raise SystemExit", repo_path=str(target_repo))
    _wait_for(
        lambda: app.coding_sessions.get(session.session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
        timeout=5,
    )
    app.coding_sessions.shutdown()


def test_polite_open_claude_phrase_uses_managed_session_lane(tmp_path) -> None:
    desktop_root = tmp_path / "Desktop"
    target_repo = desktop_root / "xr-coding-agent" / "apps" / "mac-companion"
    target_repo.mkdir(parents=True)
    (target_repo / "pyproject.toml").write_text("[project]\nname='mac-companion'\n", encoding="utf-8")

    app = build_app(
        AppConfig(
            hermes_cmd="echo",
            state_dir=tmp_path / "state",
            project_search_roots=(desktop_root,),
        )
    )
    app.hermes_runtime = FakeHermesRuntime("I should not be called for this open request.")
    app.coding_sessions = ManagedCodingSessionManager(
        tools={
            "open_claude_code": CodingSessionTool(
                intent="open_claude_code",
                title="Claude Code",
                argv=(sys.executable, "-i", "-q"),
            )
        }
    )

    response = app.handle_text(
        "can you please open up claude in the mac companion project for me",
        repo_path=str(tmp_path),
    )

    assert response["message"] == "Okay, opened Claude Code in this project."
    assert response["repo_path"] == str(target_repo)
    assert app.hermes_runtime.calls == []
    session = _wait_for_coding_session(app, "open_claude_code")
    assert session is not None
    assert session.repo_path == str(target_repo)
    app.handle_text("tell claude raise SystemExit", repo_path=str(target_repo))
    _wait_for(
        lambda: app.coding_sessions.get(session.session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
        timeout=5,
    )
    app.coding_sessions.shutdown()


def test_open_codex_resolves_repo_name_from_nested_workspace(tmp_path) -> None:
    desktop_root = tmp_path / "Desktop"
    repo_root = desktop_root / "xr-coding-agent"
    repo_root.mkdir(parents=True)
    (repo_root / ".git").mkdir()

    app = build_app(
        AppConfig(
            hermes_cmd="echo",
            state_dir=tmp_path / "state",
            project_search_roots=(desktop_root,),
        )
    )
    app.coding_sessions = ManagedCodingSessionManager(
        tools={
            "open_codex": CodingSessionTool(
                intent="open_codex",
                title="Codex CLI",
                argv=(sys.executable, "-i", "-q"),
            )
        }
    )

    response = app.handle_text(
        "open codex in the xr coding agent repo",
        repo_path=str(tmp_path),
    )

    assert response["message"] == "Okay, opened Codex CLI in this project."
    assert response["repo_path"] == str(repo_root)
    session = _wait_for_coding_session(app, "open_codex")
    assert session is not None
    assert session.repo_path == str(repo_root)
    app.handle_text("tell codex raise SystemExit", repo_path=str(repo_root))
    _wait_for(
        lambda: app.coding_sessions.get(session.session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
        timeout=5,
    )
    app.coding_sessions.shutdown()


def test_client_message_can_open_coding_session_directly(tmp_path) -> None:
    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    app.coding_sessions = ManagedCodingSessionManager(
        tools={
            "open_codex": CodingSessionTool(
                intent="open_codex",
                title="Codex CLI",
                argv=(sys.executable, "-i", "-q"),
            )
        }
    )

    app.handle_client_message(
        {
            "type": "coding_session.open",
            "payload": {
                "intent": "open_codex",
                "repo_path": str(tmp_path),
            },
        }
    )

    session = _wait_for_coding_session(app, "open_codex")
    assert session is not None
    assert session.repo_path == str(tmp_path)
    app.handle_text("tell codex raise SystemExit", repo_path=str(tmp_path))
    _wait_for(
        lambda: app.coding_sessions.get(session.session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
        timeout=5,
    )
    app.coding_sessions.shutdown()


def test_pending_worker_reply_routes_generic_yes_to_waiting_worker(tmp_path) -> None:
    claude_launcher = tmp_path / "claude_worker_question.py"
    claude_launcher.write_text(
        "\n".join(
            [
                "import sys",
                "print('CLAUDE ready', flush=True)",
                "print('Should I fix the auth bug now?', flush=True)",
                "for line in sys.stdin:",
                "    text = line.rstrip('\\n')",
                "    if text == 'exit':",
                "        break",
                "    print(f'CLAUDE RECEIVED: {text}', flush=True)",
            ]
        ),
        encoding="utf-8",
    )
    codex_launcher = tmp_path / "codex_worker_idle.py"
    codex_launcher.write_text(
        "\n".join(
            [
                "import sys",
                "print('CODEX ready', flush=True)",
                "for line in sys.stdin:",
                "    text = line.rstrip('\\n')",
                "    if text == 'exit':",
                "        break",
                "    print(f'CODEX RECEIVED: {text}', flush=True)",
            ]
        ),
        encoding="utf-8",
    )

    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    app.coding_sessions = ManagedCodingSessionManager(
        tools={
            "open_claude_code": CodingSessionTool(
                intent="open_claude_code",
                title="Claude Code",
                argv=(sys.executable, str(claude_launcher)),
            ),
            "open_codex": CodingSessionTool(
                intent="open_codex",
                title="Codex CLI",
                argv=(sys.executable, str(codex_launcher)),
            ),
        }
    )

    app.handle_text("open claude here", repo_path=str(tmp_path))
    claude_session = _wait_for_coding_session(app, "open_claude_code")
    assert claude_session is not None
    app.handle_text("open codex here", repo_path=str(tmp_path))
    codex_session = _wait_for_coding_session(app, "open_codex")
    assert codex_session is not None

    _wait_for(
        lambda: any(
            event["type"] == "worker.pending_question"
            and event["session_id"] == claude_session.session_id
            and event["payload"].get("worker_label") == "Claude 1"
            for event in app.events.recent_serialized()
        ),
        timeout=5,
    )

    response = app.handle_text("yes", repo_path=str(tmp_path))

    assert response["message"] == "I told Claude 1 to continue."
    _wait_for(
        lambda: any(
            "CLAUDE RECEIVED: The user approved it. Go ahead and continue, then report back with what changed."
            in line
            for line in (app.coding_sessions.get(claude_session.session_id).output_tail or [])
        ),
        timeout=5,
    )
    assert not any(
        "CODEX RECEIVED:" in line
        for line in (app.coding_sessions.get(codex_session.session_id).output_tail or [])
    )
    assert app._workers_by_session_id[claude_session.session_id].worker_label == "Claude 1"
    assert app._workers_by_session_id[codex_session.session_id].worker_label == "Codex 1"
    assert app._workers_by_session_id[claude_session.session_id].pending_question == ""
    assert app._workers_by_session_id[claude_session.session_id].waiting_on_user is False
    assert app._workers_by_session_id[claude_session.session_id].worker_phase == "working"
    assert claude_session.session_id not in app._pending_decisions_by_session_id

    app.handle_text("tell claude exit", repo_path=str(tmp_path))
    app.handle_text("tell codex exit", repo_path=str(tmp_path))
    _wait_for(
        lambda: app.coding_sessions.get(claude_session.session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
        timeout=5,
    )
    _wait_for(
        lambda: app.coding_sessions.get(codex_session.session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
        timeout=5,
    )
    app.coding_sessions.shutdown()


def test_pending_worker_reply_does_not_treat_i_know_as_no(tmp_path) -> None:
    launcher = tmp_path / "claude_question_again.py"
    launcher.write_text(
        "\n".join(
            [
                "import sys",
                "print('CLAUDE ready', flush=True)",
                "print('Should I fix the auth bug now?', flush=True)",
                "for line in sys.stdin:",
                "    text = line.rstrip('\\n')",
                "    if text == 'exit':",
                "        break",
                "    print(f'CLAUDE RECEIVED: {text}', flush=True)",
            ]
        ),
        encoding="utf-8",
    )

    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    app.coding_sessions = ManagedCodingSessionManager(
        tools={
            "open_claude_code": CodingSessionTool(
                intent="open_claude_code",
                title="Claude Code",
                argv=(sys.executable, str(launcher)),
            )
        }
    )

    app.handle_text("open claude here", repo_path=str(tmp_path))
    session = _wait_for_coding_session(app, "open_claude_code")
    assert session is not None
    _wait_for(lambda: app._has_pending_worker_question(repo_path=str(tmp_path)), timeout=5)

    response = app.handle_text("I know", repo_path=str(tmp_path))

    assert response["message"] != "I told Claude 1 to continue."
    assert not any(
        "The user said no for now." in line
        for line in (app.coding_sessions.get(session.session_id).output_tail or [])
    )
    app.handle_text("tell claude exit", repo_path=str(tmp_path))
    _wait_for(
        lambda: app.coding_sessions.get(session.session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
        timeout=5,
    )
    app.coding_sessions.shutdown()


def test_worker_reply_message_targets_pending_worker_without_touching_other_sessions(tmp_path) -> None:
    claude_launcher = tmp_path / "claude_worker_question_targeted.py"
    claude_launcher.write_text(
        "\n".join(
            [
                "import sys",
                "print('CLAUDE ready', flush=True)",
                "print('Should I fix the auth bug now?', flush=True)",
                "for line in sys.stdin:",
                "    text = line.rstrip('\\n')",
                "    if text == 'exit':",
                "        break",
                "    print(f'CLAUDE RECEIVED: {text}', flush=True)",
            ]
        ),
        encoding="utf-8",
    )
    codex_launcher = tmp_path / "codex_worker_idle_targeted.py"
    codex_launcher.write_text(
        "\n".join(
            [
                "import sys",
                "print('CODEX ready', flush=True)",
                "for line in sys.stdin:",
                "    text = line.rstrip('\\n')",
                "    if text == 'exit':",
                "        break",
                "    print(f'CODEX RECEIVED: {text}', flush=True)",
            ]
        ),
        encoding="utf-8",
    )

    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    app.coding_sessions = ManagedCodingSessionManager(
        tools={
            "open_claude_code": CodingSessionTool(
                intent="open_claude_code",
                title="Claude Code",
                argv=(sys.executable, str(claude_launcher)),
            ),
            "open_codex": CodingSessionTool(
                intent="open_codex",
                title="Codex CLI",
                argv=(sys.executable, str(codex_launcher)),
            ),
        }
    )

    app.handle_text("open claude here", repo_path=str(tmp_path))
    claude_session = _wait_for_coding_session(app, "open_claude_code")
    assert claude_session is not None
    app.handle_text("open codex here", repo_path=str(tmp_path))
    codex_session = _wait_for_coding_session(app, "open_codex")
    assert codex_session is not None

    _wait_for(
        lambda: any(
            event["type"] == "worker.pending_question"
            and event["session_id"] == claude_session.session_id
            for event in app.events.recent_serialized()
        ),
        timeout=5,
    )

    app.handle_client_message(
        {
            "type": "worker.reply",
            "payload": {
                "session_id": claude_session.session_id,
                "text": "approve",
                "route_via_manager": True,
            },
        }
    )

    _wait_for(
        lambda: any(
            "CLAUDE RECEIVED: The user approved it. Go ahead and continue, then report back with what changed."
            in line
            for line in (app.coding_sessions.get(claude_session.session_id).output_tail or [])
        ),
        timeout=5,
    )
    assert not any(
        "CODEX RECEIVED:" in line
        for line in (app.coding_sessions.get(codex_session.session_id).output_tail or [])
    )
    assert app._workers_by_session_id[claude_session.session_id].pending_question == ""
    assert app._workers_by_session_id[claude_session.session_id].waiting_on_user is False
    assert claude_session.session_id not in app._pending_decisions_by_session_id
    assert any(
        event["type"] == "assistant.reply"
        and event["session_id"] == claude_session.session_id
        and event["payload"].get("text") == "I told Claude 1 to continue."
        for event in app.events.recent_serialized()
    )

    app.handle_text("tell claude exit", repo_path=str(tmp_path))
    app.handle_text("tell codex exit", repo_path=str(tmp_path))
    _wait_for(
        lambda: app.coding_sessions.get(claude_session.session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
        timeout=5,
    )
    _wait_for(
        lambda: app.coding_sessions.get(codex_session.session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
        timeout=5,
    )
    app.coding_sessions.shutdown()


def test_worker_reply_message_requires_pending_question_for_manager_routed_flow(tmp_path) -> None:
    codex_launcher = tmp_path / "codex_worker_direct_only.py"
    codex_launcher.write_text(
        "\n".join(
            [
                "import sys",
                "print('CODEX ready', flush=True)",
                "for line in sys.stdin:",
                "    text = line.rstrip('\\n')",
                "    if text == 'exit':",
                "        break",
                "    print(f'CODEX RECEIVED: {text}', flush=True)",
            ]
        ),
        encoding="utf-8",
    )

    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    app.coding_sessions = ManagedCodingSessionManager(
        tools={
            "open_codex": CodingSessionTool(
                intent="open_codex",
                title="Codex CLI",
                argv=(sys.executable, str(codex_launcher)),
            ),
        }
    )

    app.handle_text("open codex here", repo_path=str(tmp_path))
    codex_session = _wait_for_coding_session(app, "open_codex")
    assert codex_session is not None

    app.handle_client_message(
        {
            "type": "worker.reply",
            "payload": {
                "session_id": codex_session.session_id,
                "text": "please keep going",
                "route_via_manager": True,
            },
        }
    )

    _wait_for(
        lambda: any(
            event["type"] == "assistant.reply"
            and event["session_id"] == codex_session.session_id
            and "not currently waiting on a manager-routed reply" in (event["payload"].get("text") or "")
            for event in app.events.recent_serialized()
        ),
        timeout=5,
    )
    assert not any(
        "CODEX RECEIVED: please keep going" in line
        for line in (app.coding_sessions.get(codex_session.session_id).output_tail or [])
    )

    app.handle_text("tell codex exit", repo_path=str(tmp_path))
    _wait_for(
        lambda: app.coding_sessions.get(codex_session.session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
        timeout=5,
    )
    app.coding_sessions.shutdown()


def test_direct_terminal_input_clears_pending_worker_state_for_client_reply(tmp_path) -> None:
    claude_launcher = tmp_path / "claude_worker_direct_pending.py"
    claude_launcher.write_text(
        "\n".join(
            [
                "import sys",
                "print('CLAUDE ready', flush=True)",
                "print('Should I fix the auth bug now?', flush=True)",
                "for line in sys.stdin:",
                "    text = line.rstrip('\\n')",
                "    if text == 'exit':",
                "        break",
                "    print(f'CLAUDE RECEIVED: {text}', flush=True)",
            ]
        ),
        encoding="utf-8",
    )

    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    app.coding_sessions = ManagedCodingSessionManager(
        tools={
            "open_claude_code": CodingSessionTool(
                intent="open_claude_code",
                title="Claude Code",
                argv=(sys.executable, str(claude_launcher)),
            ),
        }
    )

    app.handle_text("open claude here", repo_path=str(tmp_path))
    claude_session = _wait_for_coding_session(app, "open_claude_code")
    assert claude_session is not None
    _wait_for(lambda: app._has_pending_worker_question(repo_path=str(tmp_path)), timeout=5)

    app.handle_client_message(
        {
            "type": "terminal.input",
            "payload": {
                "session_id": claude_session.session_id,
                "text": "please explain the tradeoffs first",
            },
        }
    )

    _wait_for(
        lambda: any(
            "CLAUDE RECEIVED: please explain the tradeoffs first" in line
            for line in (app.coding_sessions.get(claude_session.session_id).output_tail or [])
        ),
        timeout=5,
    )
    assert app._workers_by_session_id[claude_session.session_id].waiting_on_user is False
    assert app._workers_by_session_id[claude_session.session_id].pending_question == ""
    assert claude_session.session_id not in app._pending_decisions_by_session_id
    assert any(
        event["type"] == "hermes.status"
        and event["session_id"] == claude_session.session_id
        and event["payload"].get("text") == "Claude 1 received your direct reply."
        for event in app.events.recent_serialized()
    )

    app.handle_text("tell claude exit", repo_path=str(tmp_path))
    _wait_for(
        lambda: app.coding_sessions.get(claude_session.session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
        timeout=5,
    )
    app.coding_sessions.shutdown()


def test_worker_labels_restart_per_project(tmp_path) -> None:
    repo_one = tmp_path / "repo-one"
    repo_two = tmp_path / "repo-two"
    repo_one.mkdir()
    repo_two.mkdir()

    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    app.coding_sessions = ManagedCodingSessionManager(
        tools={
            "open_claude_code": CodingSessionTool(
                intent="open_claude_code",
                title="Claude Code",
                argv=(sys.executable, "-i", "-q"),
            )
        }
    )

    response_one = app.handle_text("open claude here", repo_path=str(repo_one))
    response_two = app.handle_text("open claude here", repo_path=str(repo_two))

    session_one = app.coding_sessions.get(response_one["session_id"])
    session_two = app.coding_sessions.get(response_two["session_id"])
    assert session_one is not None
    assert session_two is not None
    assert app._workers_by_session_id[session_one.session_id].worker_label == "Claude 1"
    assert app._workers_by_session_id[session_two.session_id].worker_label == "Claude 1"

    app.coding_sessions.close_session(session_one.session_id)
    app.coding_sessions.close_session(session_two.session_id)
    app.coding_sessions.shutdown()


def test_close_claude_session_by_voice(tmp_path) -> None:
    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    app.coding_sessions = ManagedCodingSessionManager(
        tools={
            "open_claude_code": CodingSessionTool(
                intent="open_claude_code",
                title="Claude Code",
                argv=(sys.executable, "-i", "-q"),
            )
        }
    )

    app.handle_text("open claude here", repo_path=str(tmp_path))
    session = _wait_for_coding_session(app, "open_claude_code")
    assert session is not None

    response = app.handle_text("close claude", repo_path=str(tmp_path))
    assert response["message"] == "Okay, closing Claude Code."
    _wait_for(
        lambda: app.coding_sessions.get(session.session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
        timeout=5,
    )
    app.coding_sessions.shutdown()


def test_client_message_can_close_coding_session_directly(tmp_path) -> None:
    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    app.coding_sessions = ManagedCodingSessionManager(
        tools={
            "open_hermes_cli": CodingSessionTool(
                intent="open_hermes_cli",
                title="Hermes CLI",
                argv=(sys.executable, "-i", "-q"),
            )
        }
    )

    app.handle_text("open hermes here", repo_path=str(tmp_path))
    session = _wait_for_coding_session(app, "open_hermes_cli")
    assert session is not None

    app.handle_client_message(
        {
            "type": "coding_session.close",
            "payload": {
                "session_id": session.session_id,
            },
        }
    )

    _wait_for(
        lambda: app.coding_sessions.get(session.session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
        timeout=5,
    )
    app.coding_sessions.shutdown()


def test_respond_includes_backend_voice_payload_when_available(tmp_path) -> None:
    class FakeSpeech:
        def transcribe(self, text: str) -> str:
            return text

        def speak(self, text: str) -> str:
            return text

        def synthesize(self, text: str):
            from xr_agent.speech_service import SpeechSynthesisResult

            return SpeechSynthesisResult(
                text=text,
                duration_ms=1337,
                audio_base64="ZmFrZQ==",
                audio_mime_type="audio/mpeg",
                normalized_alignment={
                    "characters": ["h", "i"],
                    "character_start_times_seconds": [0.0, 0.1],
                    "character_end_times_seconds": [0.1, 0.2],
                },
                provider="elevenlabs",
                voice_id="voice-123",
                voice_name="Yuki",
                model_id="eleven_flash_v2_5",
            )

    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    app.speech = FakeSpeech()

    response = app.handle_text("what happened?", repo_path=str(tmp_path))

    assert response["message"] == "No session has completed yet."
    assistant_reply = next(
        event for event in app.events.recent_serialized() if event["type"] == "assistant.reply"
    )
    payload = assistant_reply["payload"]
    assert payload["audio_base64"] == "ZmFrZQ=="
    assert payload["audio_mime_type"] == "audio/mpeg"
    assert payload["duration_ms"] == 1337
    assert payload["voice_provider"] == "elevenlabs"
    assert payload["voice_name"] == "Yuki"
    assert payload["voice_model_id"] == "eleven_flash_v2_5"


def _wait_for_coding_session(app, intent: str, timeout: float = 5):
    deadline = time.time() + timeout
    while time.time() < deadline:
        session = app.coding_sessions.latest_session(intent=intent)
        if session is not None:
            return session
        time.sleep(0.05)
    return None


def _wait_for(predicate, timeout: float) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError("condition was not met before timeout")


class FakeHermesRuntime:
    def __init__(self, reply_text: str) -> None:
        self.reply_text = reply_text
        self.calls: list[dict[str, str]] = []

    def start(self) -> None:
        return None

    def stop(self) -> None:
        return None

    def warm_session(self, repo_path: str) -> None:
        return None

    def prompt(self, repo_path: str, prompt: str) -> HermesPromptResult:
        self.calls.append({"repo_path": repo_path, "prompt": prompt})
        return HermesPromptResult(
            reply_text=self.reply_text,
            session_id="fake-session",
            transport="acp",
        )
