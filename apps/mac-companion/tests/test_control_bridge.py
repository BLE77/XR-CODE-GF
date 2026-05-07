import importlib.util
import json
import os
from pathlib import Path
import sys
import time

import pytest

from xr_agent.config import AppConfig
from xr_agent.control_server import ControlServer
from xr_agent.coding_sessions import CodingSessionTool, ManagedCodingSessionManager
from xr_agent.hermes_plugin import install_managed_session_plugin, managed_session_plugin_source_dir
from xr_agent.main import build_app
from xr_agent.models import SessionStatus


def test_handle_control_request_manages_managed_sessions(tmp_path) -> None:
    launcher = _write_echo_launcher(tmp_path / "claude_worker.py", "CLAUDE")
    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))
    app.coding_sessions = ManagedCodingSessionManager(
        log_dir=tmp_path / "logs",
        tools={
            "open_claude_code": CodingSessionTool(
                intent="open_claude_code",
                title="Claude Code",
                argv=(sys.executable, str(launcher)),
            )
        },
    )

    try:
        opened = app.handle_control_request(
            {
                "action": "open_session",
                "tool": "claude",
                "repo_path": str(tmp_path),
            }
        )

        assert opened["ok"] is True
        assert opened["reused"] is False
        session_id = opened["session"]["session_id"]
        assert opened["session"]["intent"] == "open_claude_code"
        _wait_for(
            lambda: any(
                "CLAUDE ready" in line
                for line in (app.coding_sessions.get(session_id).output_tail or [])
            ),
            timeout=5,
        )

        sent = app.handle_control_request(
            {
                "action": "send_session_input",
                "session_id": session_id,
                "text": "continue from hermes",
            }
        )

        assert sent["ok"] is True
        _wait_for(
            lambda: any(
                "CLAUDE RECEIVED: continue from hermes" in line
                for line in (app.coding_sessions.get(session_id).output_tail or [])
            ),
            timeout=5,
        )

        screen = app.handle_control_request(
            {
                "action": "read_session_screen",
                "session_id": session_id,
            }
        )
        assert screen["ok"] is True
        assert "CLAUDE RECEIVED: continue from hermes" in (screen["session"]["screen_text"] or "")

        listed = app.handle_control_request({"action": "list_sessions"})
        assert listed["ok"] is True
        assert [session["session_id"] for session in listed["sessions"]] == [session_id]

        closed = app.handle_control_request(
            {
                "action": "close_session",
                "session_id": session_id,
            }
        )
        assert closed["ok"] is True
        _wait_for(
            lambda: app.coding_sessions.get(session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
            timeout=5,
        )

        listed_finished = app.handle_control_request({"action": "list_sessions", "include_finished": True})
        assert listed_finished["ok"] is True
        assert session_id in [session["session_id"] for session in listed_finished["sessions"]]
    finally:
        app.coding_sessions.shutdown()


def test_handle_control_request_validates_errors(tmp_path) -> None:
    launcher = _write_echo_launcher(tmp_path / "claude_validation.py", "CLAUDE")
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

    try:
        assert app.handle_control_request({}) == {"ok": False, "error": "Control requests need an action."}

        missing_repo = app.handle_control_request({"action": "open_session", "tool": "claude"})
        assert missing_repo["ok"] is False
        assert missing_repo["error"] == "open_session needs a repo_path."

        invalid_tool = app.handle_control_request(
            {
                "action": "open_session",
                "tool": "unknown",
                "repo_path": str(tmp_path),
            }
        )
        assert invalid_tool["ok"] is False
        assert "tool=claude, codex, hermes, or kimi" in invalid_tool["error"]

        opened = app.handle_control_request(
            {
                "action": "open_session",
                "tool": "claude",
                "repo_path": str(tmp_path),
            }
        )
        session_id = opened["session"]["session_id"]

        missing_text = app.handle_control_request(
            {
                "action": "send_session_input",
                "session_id": session_id,
            }
        )
        assert missing_text["ok"] is False
        assert missing_text["error"] == "send_session_input needs text."

        missing_session = app.handle_control_request(
            {
                "action": "read_session_screen",
                "session_id": "term_missing",
            }
        )
        assert missing_session["ok"] is False
        assert "No managed coding session found for term_missing" in missing_session["error"]
    finally:
        app.coding_sessions.shutdown()


def test_plugin_bridge_controls_live_sessions_over_tcp(tmp_path, monkeypatch) -> None:
    plugin = _load_plugin_module()
    launcher = _write_echo_launcher(tmp_path / "codex_worker.py", "CODEX")
    app = build_app(
        AppConfig(
            hermes_cmd="echo",
            state_dir=tmp_path / "state",
            event_host="127.0.0.1",
            event_port=0,
            control_host="127.0.0.1",
            control_port=0,
        )
    )
    app.coding_sessions = ManagedCodingSessionManager(
        log_dir=tmp_path / "logs",
        tools={
            "open_codex": CodingSessionTool(
                intent="open_codex",
                title="Codex CLI",
                argv=(sys.executable, str(launcher)),
            )
        },
    )
    monkeypatch.setattr(app, "_install_hermes_managed_session_plugin", lambda: None)

    try:
        app.start()
        assert plugin._bridge_available() is True

        opened = json.loads(
            plugin.xr_managed_session(
                {
                    "action": "open_session",
                    "tool": "codex",
                    "repo_path": str(tmp_path),
                }
            )
        )
        assert opened["ok"] is True
        session_id = opened["session"]["session_id"]

        sent = json.loads(
            plugin.xr_managed_session(
                {
                    "action": "send_session_input",
                    "session_id": session_id,
                    "text": "ship it",
                }
            )
        )
        assert sent["ok"] is True
        _wait_for(
            lambda: any(
                "CODEX RECEIVED: ship it" in line
                for line in (app.coding_sessions.get(session_id).output_tail or [])
            ),
            timeout=5,
        )

        screen = json.loads(
            plugin.xr_managed_session(
                {
                    "action": "read_session_screen",
                    "session_id": session_id,
                }
            )
        )
        assert screen["ok"] is True
        assert "CODEX RECEIVED: ship it" in (screen["session"]["screen_text"] or "")

        listed = json.loads(plugin.xr_managed_session({"action": "list_sessions"}))
        assert listed["ok"] is True
        assert session_id in [session["session_id"] for session in listed["sessions"]]

        closed = json.loads(
            plugin.xr_managed_session(
                {
                    "action": "close_session",
                    "session_id": session_id,
                }
            )
        )
        assert closed["ok"] is True
        _wait_for(
            lambda: app.coding_sessions.get(session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
            timeout=5,
        )
    finally:
        app.stop()

    assert plugin._bridge_available() is False


def test_install_managed_session_plugin_prunes_stale_files(tmp_path) -> None:
    hermes_home = tmp_path / "hermes-home"
    destination = hermes_home / "plugins" / "xr_managed_sessions"
    (destination / "stale-dir").mkdir(parents=True)
    (destination / "stale-dir" / "old.txt").write_text("stale", encoding="utf-8")
    (destination / "obsolete.txt").write_text("remove me", encoding="utf-8")

    installed = install_managed_session_plugin(hermes_home=hermes_home)

    assert installed == destination
    source_dir = managed_session_plugin_source_dir()
    assert (destination / "plugin.yaml").read_text(encoding="utf-8") == (
        source_dir / "plugin.yaml"
    ).read_text(encoding="utf-8")
    assert (destination / "__init__.py").read_text(encoding="utf-8") == (
        source_dir / "__init__.py"
    ).read_text(encoding="utf-8")
    assert not (destination / "obsolete.txt").exists()
    assert not (destination / "stale-dir").exists()

    assert install_managed_session_plugin(hermes_home=hermes_home) == destination


def test_bridge_available_requires_live_server(monkeypatch) -> None:
    plugin = _load_plugin_module()
    monkeypatch.delenv("XR_AGENT_CONTROL_HOST", raising=False)
    monkeypatch.delenv("XR_AGENT_CONTROL_PORT", raising=False)
    assert plugin._bridge_available() is False

    server = ControlServer()
    server.set_request_handler(lambda request: {"ok": True, "echo": request})
    server.start_in_background("127.0.0.1", 0)

    try:
        monkeypatch.setenv("XR_AGENT_CONTROL_HOST", "127.0.0.1")
        monkeypatch.setenv("XR_AGENT_CONTROL_PORT", str(server.bound_port))
        assert plugin._bridge_available() is True
    finally:
        server.stop_in_background()

    assert plugin._bridge_available() is False


def test_app_start_restores_control_environment_on_failure(tmp_path, monkeypatch) -> None:
    app = build_app(
        AppConfig(
            hermes_cmd="echo",
            state_dir=tmp_path / "state",
            event_host="127.0.0.1",
            event_port=0,
            control_host="0.0.0.0",
            control_port=0,
        )
    )
    monkeypatch.setattr(app, "_install_hermes_managed_session_plugin", lambda: None)
    monkeypatch.setenv("XR_AGENT_CONTROL_HOST", "previous-host")
    monkeypatch.setenv("XR_AGENT_CONTROL_PORT", "9999")

    def fail_event_server(host: str, port: int) -> None:
        assert host == "127.0.0.1"
        assert port == 0
        assert os.environ["XR_AGENT_CONTROL_HOST"] == "127.0.0.1"
        raise RuntimeError("event bridge boom")

    monkeypatch.setattr(app.events, "start_in_background", fail_event_server)

    with pytest.raises(RuntimeError, match="event bridge boom"):
        app.start()

    assert os.environ["XR_AGENT_CONTROL_HOST"] == "previous-host"
    assert os.environ["XR_AGENT_CONTROL_PORT"] == "9999"
    assert app.control.bound_port is None


def _load_plugin_module():
    plugin_path = Path(__file__).resolve().parents[1] / "hermes_plugins" / "xr_managed_sessions" / "__init__.py"
    spec = importlib.util.spec_from_file_location("xr_managed_sessions_test_plugin", plugin_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_echo_launcher(path: Path, label: str) -> Path:
    path.write_text(
        "\n".join(
            [
                "import sys",
                f"print('{label} ready', flush=True)",
                "for line in sys.stdin:",
                "    text = line.rstrip('\\n')",
                "    if text == 'exit':",
                "        break",
                f"    print('{label} RECEIVED: ' + text, flush=True)",
            ]
        ),
        encoding="utf-8",
    )
    return path


def _wait_for(predicate, timeout: float) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError("condition was not met before timeout")
