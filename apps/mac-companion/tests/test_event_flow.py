import sys
import time

from xr_agent.config import AppConfig
from xr_agent.coding_sessions import CodingSessionTool, ManagedCodingSessionManager
from xr_agent.main import build_app, parse_args


def test_parse_args_supports_show_events_flag() -> None:
    args = parse_args(["--repo", "/tmp/demo", "--once", "run tests", "--show-events"])

    assert args.show_events is True


def test_run_tests_emits_session_and_summary_events(tmp_path) -> None:
    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))

    response = app.handle_text("run tests", repo_path=str(tmp_path))
    app.wait_for_session(response["session_id"], timeout=5)

    event_types = [event["type"] for event in app.events.recent_serialized()]

    assert "speech.transcript" in event_types
    assert "avatar.thinking" in event_types
    assert "session.started" in event_types
    assert "session.output" in event_types
    assert any(event_type in event_types for event_type in ["session.finished", "session.failed"])
    assert "agent.summary" in event_types


def test_voice_command_messages_are_routed_through_app_handler(tmp_path) -> None:
    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))

    app.handle_client_message(
        {
            "type": "voice.command",
            "payload": {"text": "what happened?", "repo_path": str(tmp_path)},
        }
    )

    event_types = [event["type"] for event in app.events.recent_serialized()]

    assert "speech.transcript" in event_types
    assert "agent.summary" in event_types


def test_what_happened_emits_assistant_reply(tmp_path) -> None:
    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))

    app.handle_client_message(
        {
            "type": "voice.command",
            "payload": {"text": "what happened?", "repo_path": str(tmp_path)},
        }
    )

    event_types = [event["type"] for event in app.events.recent_serialized()]

    assert "assistant.reply" in event_types


def test_project_picker_message_emits_selected_project_and_status(tmp_path, monkeypatch) -> None:
    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    chosen_path = str(tmp_path / "picked-repo")

    monkeypatch.setattr(app, "_pick_project_folder_on_mac", lambda starting_path=None: chosen_path)

    app.handle_client_message(
        {
            "type": "project.pick_folder",
            "payload": {"starting_path": str(tmp_path)},
        }
    )

    events = app.events.recent_serialized()

    assert any(
        event["type"] == "project.selected" and event["payload"] == {"path": chosen_path}
        for event in events
    )
    assert any(
        event["type"] == "hermes.status"
        and event["payload"] == {"text": f"Current project set to {chosen_path}."}
        for event in events
    )


def test_project_picker_cancellation_emits_status_only(tmp_path, monkeypatch) -> None:
    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))

    monkeypatch.setattr(app, "_pick_project_folder_on_mac", lambda starting_path=None: None)

    app.handle_client_message(
        {
            "type": "project.pick_folder",
            "payload": {},
        }
    )

    events = app.events.recent_serialized()

    assert any(
        event["type"] == "hermes.status"
        and event["payload"] == {"text": "Project picker was cancelled on your Mac."}
        for event in events
    )
    assert not any(event["type"] == "project.selected" for event in events)


def test_worker_pending_question_emits_supervisor_events(tmp_path) -> None:
    launcher = tmp_path / "claude_question.py"
    launcher.write_text(
        "\n".join(
            [
                "import sys",
                "print('CLAUDE ready', flush=True)",
                "print('Should I review the patch now?', flush=True)",
                "for line in sys.stdin:",
                "    text = line.rstrip('\\n')",
                "    if text == 'exit':",
                "        break",
            ]
        ),
        encoding="utf-8",
    )

    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    app.coding_sessions = ManagedCodingSessionManager(
        log_dir=tmp_path / "state" / "coding-sessions",
        tools={
            "open_claude_code": CodingSessionTool(
                intent="open_claude_code",
                title="Claude Code",
                argv=(sys.executable, str(launcher)),
            )
        }
    )

    response = app.handle_text("open claude here", repo_path=str(tmp_path))

    deadline = time.time() + 5
    while time.time() < deadline:
        events = app.events.recent_serialized()
        if any(event["type"] == "worker.pending_question" for event in events):
            break
        time.sleep(0.05)
    else:
        raise AssertionError("worker.pending_question event was not emitted")

    assert any(
        event["type"] == "worker.updated"
        and event["session_id"] == response["session_id"]
        and event["payload"].get("worker_label") == "Claude 1"
        and event["payload"].get("waiting_on_user") is True
        and event["payload"].get("worker_phase") == "waiting_on_user"
        for event in events
    )
    assert any(
        event["type"] == "worker.pending_question"
        and event["session_id"] == response["session_id"]
        and event["payload"].get("question") == "Should I review the patch now?"
        and event["payload"].get("decision_type") == "review"
        for event in events
    )
    assert any(
        event["type"] == "hermes.status"
        and event["session_id"] == response["session_id"]
        and event["payload"].get("worker_label") == "Claude 1"
        for event in events
    )

    app.coding_sessions.shutdown()


def test_open_claude_session_emits_terminal_and_reply_events(tmp_path) -> None:
    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    app.coding_sessions = ManagedCodingSessionManager(
        log_dir=tmp_path / "state" / "coding-sessions",
        tools={
            "open_claude_code": CodingSessionTool(
                intent="open_claude_code",
                title="Claude Code",
                argv=(sys.executable, "-i", "-q"),
            )
        }
    )

    response = app.handle_text("open claude here", repo_path=str(tmp_path))

    events = app.events.recent_serialized()
    event_types = [event["type"] for event in events]

    assert "terminal.started" in event_types
    assert "assistant.reply" in event_types
    assert "agent.summary" in event_types
    assert any(
        event["type"] == "assistant.reply"
        and event["session_id"] == response["session_id"]
        and event["payload"].get("intent") == "open_claude_code"
        for event in events
    )
    assert any(
        event["type"] == "terminal.started"
        and event["session_id"] == response["session_id"]
        and event["payload"].get("log_path")
        for event in events
    )

    app.coding_sessions.shutdown()
