import base64
import sys
import time
from datetime import datetime

from xr_agent.config import AppConfig
from xr_agent.coding_sessions import CodingSessionTool, ManagedCodingSession, ManagedCodingSessionManager
from xr_agent.event_server import EventServer
from xr_agent.main import build_app, parse_args
from xr_agent.models import SessionStatus


def _wait_for_event(app, predicate, timeout: float = 2.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        event = next((item for item in app.events.recent_serialized() if predicate(item)), None)
        if event is not None:
            return event
        time.sleep(0.01)
    raise AssertionError("expected event was not emitted before timeout")


def test_parse_args_supports_show_events_flag() -> None:
    args = parse_args(["--repo", "/tmp/demo", "--once", "run tests", "--show-events"])

    assert args.show_events is True


def test_event_replay_excludes_large_voice_payloads() -> None:
    assert "avatar.speaking" in EventServer._REPLAY_EXCLUDED_TYPES
    assert "voice.realtime.session" in EventServer._REPLAY_EXCLUDED_TYPES
    assert "voice.realtime.sdp.answer" in EventServer._REPLAY_EXCLUDED_TYPES


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

    _wait_for_event(app, lambda event: event["type"] == "agent.summary")
    event_types = [event["type"] for event in app.events.recent_serialized()]

    assert "speech.transcript" in event_types
    assert "agent.summary" in event_types


def test_voice_audio_messages_are_transcribed_and_routed(tmp_path) -> None:
    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))

    app.speech.transcribe_audio = lambda audio, mime_type=None: "what happened?"

    app.handle_client_message(
        {
            "type": "voice.audio",
            "payload": {
                "audio_base64": base64.b64encode(b"fake-webm-audio").decode("ascii"),
                "mime_type": "audio/webm",
                "repo_path": str(tmp_path),
            },
        }
    )

    _wait_for_event(app, lambda event: event["type"] == "assistant.reply")
    events = app.events.recent_serialized()

    assert any(event["type"] == "hermes.status" for event in events)
    assert any(
        event["type"] == "speech.transcript" and event["payload"]["text"] == "what happened?"
        for event in events
    )
    assert any(event["type"] == "assistant.reply" for event in events)


def test_what_happened_emits_assistant_reply(tmp_path) -> None:
    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))

    app.handle_client_message(
        {
            "type": "voice.command",
            "payload": {"text": "what happened?", "repo_path": str(tmp_path)},
        }
    )

    _wait_for_event(app, lambda event: event["type"] == "assistant.reply")
    event_types = [event["type"] for event in app.events.recent_serialized()]

    assert "assistant.reply" in event_types


def test_coding_session_sync_emits_ack_even_when_no_sessions_exist(tmp_path) -> None:
    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))

    app.handle_client_message({"type": "coding_sessions.sync", "payload": {}})

    events = app.events.recent_serialized()

    assert any(
        event["type"] == "coding_sessions.synced"
        and event["payload"]["session_count"] == 0
        and event["payload"]["live_count"] == 0
        and event["payload"]["sessions"] == []
        and event["payload"]["complete"] is True
        for event in events
    )


def test_coding_session_sync_emits_compact_snapshot_with_large_prior_output(tmp_path) -> None:
    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    session = ManagedCodingSession(
        session_id="term_big",
        intent="open_codex",
        title="Codex CLI",
        repo_path=str(tmp_path),
        command="codex",
        status=SessionStatus.RUNNING,
        started_at=datetime.now(),
        pid=1234,
        log_path=str(tmp_path / "codex.log"),
        output_tail=[f"line {index} " + ("x" * 5000) for index in range(24)],
        screen_text="screen " + ("y" * 50000),
        screen_rows=48,
        screen_columns=160,
    )
    with app.coding_sessions._lock:
        app.coding_sessions._sessions[session.session_id] = session
        app.coding_sessions._start_order.append(session.session_id)
    app._update_worker_state(
        session,
        status_text="Working",
        worker_phase="working",
        manager_summary="Codex 1 is making progress on the backend event stream.",
        last_update="Reading event server code.",
    )

    app.handle_client_message({"type": "coding_sessions.sync", "payload": {}})

    events = app.events.recent_serialized()
    synced = next(event for event in events if event["type"] == "coding_sessions.synced")
    payload = synced["payload"]
    snapshot = payload["sessions"][0]

    assert payload["session_count"] == 1
    assert payload["live_count"] == 1
    assert payload["complete"] is True
    assert snapshot["session_id"] == "term_big"
    assert snapshot["tool_label"] == "Codex"
    assert snapshot["repo_path"] == str(tmp_path)
    assert snapshot["status"] == "running"
    assert snapshot["phase"] == "working"
    assert snapshot["worker_label"] == "Codex 1"
    assert snapshot["manager_summary"] == "Codex 1 is making progress on the backend event stream."
    assert snapshot["output_line_count"] == 24
    assert 0 < len(snapshot["output_summary"]) < 1000
    assert snapshot["started_at"]
    assert snapshot["snapshot_at"]
    assert "screen_text" not in snapshot
    assert "output_tail" not in snapshot
    assert "audio_base64" not in snapshot
    assert not any(event["type"] in {"terminal.output", "terminal.screen"} for event in events)


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
