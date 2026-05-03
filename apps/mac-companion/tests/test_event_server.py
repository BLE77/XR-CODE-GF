import asyncio
import json
import threading
import time

import websockets

from xr_agent.config import AppConfig
from xr_agent.event_server import EventServer, make_event
from xr_agent.main import build_app, main


def test_app_start_and_stop_use_configured_event_server(tmp_path, monkeypatch) -> None:
    app = build_app(
        AppConfig(
            hermes_cmd="echo",
            state_dir=tmp_path / "state",
            event_host="127.0.0.1",
            event_port=9876,
        )
    )
    calls: list[tuple[str, object, object | None]] = []

    monkeypatch.setattr(
        app,
        "_install_hermes_managed_session_plugin",
        lambda: calls.append(("plugin", None, None)),
    )
    monkeypatch.setattr(
        app.control,
        "start_in_background",
        lambda host, port: calls.append(("control-start", host, port)),
    )
    monkeypatch.setattr(
        app,
        "_configure_hermes_session_control_environment",
        lambda: calls.append(("control-env", None, None)),
    )
    monkeypatch.setattr(
        app,
        "_start_command_center",
        lambda: calls.append(("command-center-start", None, None)),
    )
    monkeypatch.setattr(
        app.events,
        "start_in_background",
        lambda host, port: calls.append(("start", host, port)),
    )
    monkeypatch.setattr(
        app,
        "_stop_command_center",
        lambda: calls.append(("command-center-stop", None, None)),
    )
    monkeypatch.setattr(
        app.events,
        "stop_in_background",
        lambda: calls.append(("stop", None, None)),
    )
    monkeypatch.setattr(
        app.control,
        "stop_in_background",
        lambda: calls.append(("control-stop", None, None)),
    )

    app.start()
    app.stop()

    assert calls == [
        ("plugin", None, None),
        ("control-start", "127.0.0.1", 8766),
        ("control-env", None, None),
        ("command-center-start", None, None),
        ("start", "127.0.0.1", 9876),
        ("command-center-stop", None, None),
        ("stop", None, None),
        ("control-stop", None, None),
    ]


def test_main_starts_and_stops_event_server_for_one_shot(tmp_path, monkeypatch, capsys) -> None:
    class FakeApp:
        def __init__(self) -> None:
            self.started = 0
            self.stopped = 0
            self.events = EventServer()

        def start(self) -> None:
            self.started += 1

        def stop(self) -> None:
            self.stopped += 1

        def handle_text(self, text: str, repo_path: str) -> dict[str, str]:
            return {"message": f"handled {text} in {repo_path}"}

    app = FakeApp()
    monkeypatch.setattr("xr_agent.main.build_app", lambda *args, **kwargs: app)

    exit_code = main(["--repo", str(tmp_path), "--once", "what happened?"])

    assert exit_code == 0
    assert app.started == 1
    assert app.stopped == 1
    assert capsys.readouterr().out.strip() == f"handled what happened? in {tmp_path}"


def test_event_server_replays_buffered_events_and_streams_new_ones() -> None:
    server = EventServer()
    server.publish(make_event("session.started", "session-1", {"title": "Run tests"}))
    server.start_in_background("127.0.0.1", 0)
    port = server.bound_port
    assert port is not None

    async def scenario() -> None:
        async with websockets.connect(f"ws://127.0.0.1:{port}") as websocket:
            replay = json.loads(await asyncio.wait_for(websocket.recv(), timeout=2))
            assert replay["type"] == "session.started"
            assert replay["session_id"] == "session-1"
            assert replay["payload"] == {"title": "Run tests"}

            def publish_from_worker() -> None:
                server.publish(make_event("agent.summary", "session-1", {"text": "All green."}))

            worker = threading.Thread(target=publish_from_worker)
            worker.start()
            worker.join(timeout=2)
            assert not worker.is_alive()

            live = json.loads(await asyncio.wait_for(websocket.recv(), timeout=2))
            assert live["type"] == "agent.summary"
            assert live["payload"] == {"text": "All green."}

    try:
        asyncio.run(scenario())
    finally:
        server.stop_in_background()


def test_event_server_does_not_replay_noisy_terminal_frames() -> None:
    server = EventServer()
    server.publish(make_event("terminal.screen", "term-1", {"screen_text": "spinner"}))
    server.publish(make_event("terminal.output", "term-1", {"line": "tick"}))
    server.publish(make_event("assistant.reply", None, {"text": "Ready."}))
    server.start_in_background("127.0.0.1", 0)
    port = server.bound_port
    assert port is not None

    async def scenario() -> None:
        async with websockets.connect(f"ws://127.0.0.1:{port}") as websocket:
            replay = json.loads(await asyncio.wait_for(websocket.recv(), timeout=2))
            assert replay["type"] == "assistant.reply"
            assert replay["payload"] == {"text": "Ready."}

    try:
        asyncio.run(scenario())
    finally:
        server.stop_in_background()


def test_event_server_routes_client_messages_to_handler() -> None:
    server = EventServer()
    received: list[dict[str, object]] = []
    server.set_message_handler(lambda payload: received.append(payload))
    server.start_in_background("127.0.0.1", 0)
    port = server.bound_port
    assert port is not None

    async def scenario() -> None:
        async with websockets.connect(f"ws://127.0.0.1:{port}") as websocket:
            await websocket.send(
                json.dumps(
                    {
                        "type": "voice.command",
                        "payload": {"text": "run tests", "repo_path": "/tmp/demo"},
                    }
                )
            )
            await asyncio.sleep(0.1)

    try:
        asyncio.run(scenario())
    finally:
        server.stop_in_background()

    assert received == [
        {
            "type": "voice.command",
            "payload": {"text": "run tests", "repo_path": "/tmp/demo"},
        }
    ]


def test_slow_client_handler_does_not_block_event_delivery() -> None:
    server = EventServer()

    def slow_handler(_: dict[str, object]) -> None:
        time.sleep(0.35)

    server.set_message_handler(slow_handler)
    server.start_in_background("127.0.0.1", 0)
    port = server.bound_port
    assert port is not None

    async def scenario() -> None:
        async with websockets.connect(f"ws://127.0.0.1:{port}") as websocket:
            await websocket.send(json.dumps({"type": "voice.command", "payload": {"text": "run tests"}}))

            def publish_from_worker() -> None:
                time.sleep(0.05)
                server.publish(make_event("agent.summary", None, {"text": "still responsive"}))

            worker = threading.Thread(target=publish_from_worker)
            worker.start()
            try:
                live = json.loads(await asyncio.wait_for(websocket.recv(), timeout=0.2))
            finally:
                worker.join(timeout=1)

            assert live["type"] == "agent.summary"
            assert live["payload"] == {"text": "still responsive"}

    try:
        asyncio.run(scenario())
    finally:
        server.stop_in_background()
