from __future__ import annotations

import json
import os
import socket
from typing import Any


_DEFAULT_CONTROL_HOST = "127.0.0.1"
_DEFAULT_CONTROL_PORT = 8766
_CONTROL_TIMEOUT_SECONDS = 15.0


XR_MANAGED_SESSION_SCHEMA = {
    "name": "xr_managed_session",
    "description": (
        "Inspect and control XR Coding Agent managed coding sessions on this Mac. "
        "Use this when you want Claude Code, Codex, or Hermes CLI to work as a "
        "separate managed terminal session that the headset can display live. "
        "Supported actions: list_sessions, open_session, send_session_input, "
        "read_session_screen, close_session. Prefer this tool over shelling out "
        "when you need to continue work in Claude/Codex, check what a worker is "
        "doing, or stop a worker."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "description": (
                    "Which managed-session action to perform. "
                    "One of: list_sessions, open_session, send_session_input, "
                    "read_session_screen, close_session."
                ),
            },
            "tool": {
                "type": "string",
                "description": (
                    "The managed worker to target: claude, codex, hermes, or an "
                    "intent like open_claude_code."
                ),
            },
            "repo_path": {
                "type": "string",
                "description": "Repository path to open the managed session in.",
            },
            "session_id": {
                "type": "string",
                "description": "Specific managed session ID to target.",
            },
            "text": {
                "type": "string",
                "description": "Exact text to send to an existing managed session.",
            },
            "reuse_existing": {
                "type": "boolean",
                "description": "When opening, reuse the newest matching running session if one already exists.",
            },
            "dangerously_skip_permissions": {
                "type": "boolean",
                "description": "When opening Claude, request dangerously skip permissions for trusted repo flows.",
            },
            "include_finished": {
                "type": "boolean",
                "description": "When listing sessions, include finished and failed sessions too.",
            },
        },
        "required": ["action"],
    },
}


def _control_host() -> str:
    return os.environ.get("XR_AGENT_CONTROL_HOST", _DEFAULT_CONTROL_HOST).strip() or _DEFAULT_CONTROL_HOST


def _control_port() -> int:
    raw = os.environ.get("XR_AGENT_CONTROL_PORT", str(_DEFAULT_CONTROL_PORT)).strip()
    try:
        return int(raw)
    except ValueError:
        return _DEFAULT_CONTROL_PORT


def _bridge_available() -> bool:
    raw_host = os.environ.get("XR_AGENT_CONTROL_HOST")
    raw_port = os.environ.get("XR_AGENT_CONTROL_PORT")
    if not raw_host or not raw_port:
        return False

    try:
        port = int(raw_port.strip())
    except ValueError:
        return False

    try:
        with socket.create_connection((raw_host.strip(), port), timeout=0.25):
            return True
    except OSError:
        return False


def _request_control(payload: dict[str, Any]) -> dict[str, Any]:
    host = _control_host()
    port = _control_port()
    with socket.create_connection((host, port), timeout=_CONTROL_TIMEOUT_SECONDS) as connection:
        connection.sendall((json.dumps(payload) + "\n").encode("utf-8"))
        response = b""
        while not response.endswith(b"\n"):
            chunk = connection.recv(65536)
            if not chunk:
                break
            response += chunk
    if not response:
        return {"ok": False, "error": "XR Coding Agent control server returned no response."}
    try:
        decoded = json.loads(response.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return {"ok": False, "error": f"Invalid control server response: {exc}"}
    if not isinstance(decoded, dict):
        return {"ok": False, "error": "XR Coding Agent control server returned a non-object payload."}
    return decoded


def xr_managed_session(args: dict[str, Any], **kwargs: Any) -> str:
    payload = {
        "action": args.get("action"),
        "tool": args.get("tool"),
        "repo_path": args.get("repo_path"),
        "session_id": args.get("session_id"),
        "text": args.get("text"),
        "reuse_existing": args.get("reuse_existing", True),
        "dangerously_skip_permissions": args.get("dangerously_skip_permissions", False),
        "include_finished": args.get("include_finished", False),
    }
    return json.dumps(_request_control(payload), ensure_ascii=False)


def register(ctx: Any) -> None:
    ctx.register_tool(
        name="xr_managed_session",
        toolset="xr-managed-sessions",
        schema=XR_MANAGED_SESSION_SCHEMA,
        handler=xr_managed_session,
        check_fn=_bridge_available,
        description=XR_MANAGED_SESSION_SCHEMA["description"],
        emoji="🧭",
    )
