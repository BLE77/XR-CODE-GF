from __future__ import annotations

import json
import socket
import threading
import webbrowser
from dataclasses import dataclass
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


@dataclass(frozen=True)
class CommandCenterProject:
    label: str
    path: str


class CommandCenterControlClient:
    def __init__(self, host: str, port: int, *, timeout: float = 2.0) -> None:
        self.host = host
        self.port = port
        self.timeout = timeout

    def request(self, payload: dict[str, Any]) -> dict[str, Any]:
        raw_payload = (json.dumps(payload) + "\n").encode("utf-8")
        with socket.create_connection((self.host, self.port), timeout=self.timeout) as connection:
            connection.sendall(raw_payload)
            response = bytearray()
            while not response.endswith(b"\n"):
                chunk = connection.recv(65536)
                if not chunk:
                    break
                response.extend(chunk)
        if not response:
            raise RuntimeError("No response from XR control bridge.")
        decoded = json.loads(response.decode("utf-8"))
        if not isinstance(decoded, dict):
            raise RuntimeError("XR control bridge returned a non-object response.")
        return decoded


class CommandCenterStateStore:
    def __init__(
        self,
        *,
        control_client: CommandCenterControlClient,
        default_repo_path: str,
        command_center_url: str,
        event_stream_url: str | None = None,
        saved_projects: list[CommandCenterProject] | None = None,
    ) -> None:
        normalized_default_repo = str(Path(default_repo_path).expanduser().resolve())
        self.control_client = control_client
        self.default_repo_path = normalized_default_repo
        self.command_center_url = command_center_url
        self.event_stream_url = event_stream_url
        self.saved_projects = self._normalize_projects(
            saved_projects or [CommandCenterProject(label=Path(normalized_default_repo).name, path=normalized_default_repo)]
        )

    def state_payload(self) -> dict[str, Any]:
        result = self.control_client.request({"action": "list_sessions", "include_finished": True})
        sessions = result.get("sessions", []) if isinstance(result, dict) else []
        if not isinstance(sessions, list):
            sessions = []
        session_payloads = [self._command_center_session_payload(session) for session in sessions]
        overview = self._overview_payload(session_payloads)
        return {
            "ok": True,
            "bridge_status": "Connected",
            "control_bridge_address": f"{self.control_client.host}:{self.control_client.port}",
            "command_center_url": self.command_center_url,
            "current_project": self.default_repo_path,
            "projects": [project.__dict__ for project in self.saved_projects],
            "overview": overview,
            "sessions": session_payloads,
            "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }

    def recent_events_payload(self, *, limit: int = 24) -> dict[str, Any]:
        result = self.control_client.request({"action": "recent_events", "limit": limit})
        self._require_success(result, "load recent events")
        events = result.get("events")
        if not isinstance(events, list):
            events = []
        return {"ok": True, "events": events}

    def set_current_project(self, repo_path: str) -> None:
        normalized_repo = str(Path(repo_path).expanduser().resolve())
        self._remember_project(normalized_repo)

    def open_session(
        self,
        *,
        tool: str,
        repo_path: str,
        reuse_existing: bool = True,
        dangerously_skip_permissions: bool = False,
    ) -> dict[str, Any]:
        normalized_repo = str(Path(repo_path).expanduser().resolve())
        result = self.control_client.request(
            {
                "action": "open_session",
                "tool": tool,
                "repo_path": normalized_repo,
                "reuse_existing": reuse_existing,
                "dangerously_skip_permissions": dangerously_skip_permissions,
            }
        )
        self._require_success(result, "open the session")
        self._remember_project(normalized_repo)
        return result

    def send_to_session(self, *, session_id: str, text: str) -> dict[str, Any]:
        result = self.control_client.request(
            {
                "action": "send_session_input",
                "session_id": session_id,
                "text": text,
            }
        )
        self._require_success(result, "send input to the session")
        return result

    def read_session(self, *, session_id: str) -> dict[str, Any]:
        result = self.control_client.request(
            {
                "action": "read_session_screen",
                "session_id": session_id,
            }
        )
        self._require_success(result, "read the session")
        return result

    def close_session(self, *, session_id: str) -> dict[str, Any]:
        result = self.control_client.request(
            {
                "action": "close_session",
                "session_id": session_id,
            }
        )
        self._require_success(result, "close the session")
        return result

    def _remember_project(self, repo_path: str) -> None:
        self.default_repo_path = repo_path
        existing = {project.path for project in self.saved_projects}
        if repo_path not in existing:
            self.saved_projects.append(
                CommandCenterProject(label=Path(repo_path).name or repo_path, path=repo_path)
            )

    @staticmethod
    def _require_success(result: dict[str, Any], action: str) -> None:
        if result.get("ok", True):
            return
        detail = str(result.get("error") or f"Could not {action}.").strip()
        raise RuntimeError(detail)

    @staticmethod
    def _normalize_projects(projects: list[CommandCenterProject]) -> list[CommandCenterProject]:
        normalized: list[CommandCenterProject] = []
        seen_paths: set[str] = set()
        for project in projects:
            path = str(Path(project.path).expanduser().resolve())
            if path in seen_paths:
                continue
            seen_paths.add(path)
            label = project.label.strip() or Path(path).name or path
            normalized.append(CommandCenterProject(label=label, path=path))
        return normalized

    @staticmethod
    def _command_center_session_payload(session: Any) -> dict[str, Any]:
        if not isinstance(session, dict):
            return {}
        screen_text = session.get("screen_text")
        if isinstance(screen_text, str) and len(screen_text) > 12000:
            screen_text = screen_text[-12000:]
        return {
            "session_id": session.get("session_id"),
            "intent": session.get("intent"),
            "title": session.get("title"),
            "repo_path": session.get("repo_path"),
            "command": session.get("command"),
            "status": session.get("status"),
            "pid": session.get("pid"),
            "exit_code": session.get("exit_code"),
            "summary": session.get("summary"),
            "log_path": session.get("log_path"),
            "screen_text": screen_text,
            "screen_rows": session.get("screen_rows"),
            "screen_columns": session.get("screen_columns"),
            "worker_label": session.get("worker_label"),
            "task_title": session.get("task_title"),
            "worker_phase": session.get("worker_phase"),
            "status_text": session.get("status_text"),
            "manager_summary": session.get("manager_summary"),
            "waiting_on_user": session.get("waiting_on_user"),
            "needs_review": session.get("needs_review"),
            "blocked_reason": session.get("blocked_reason"),
            "pending_question": session.get("pending_question"),
            "last_update": session.get("last_update"),
        }

    def _overview_payload(self, sessions: list[dict[str, Any]]) -> dict[str, Any]:
        current_project = self.default_repo_path
        live_sessions = [
            session
            for session in sessions
            if session.get("status") in {"starting", "running"} and session.get("repo_path") == current_project
        ]
        pending_sessions = [session for session in live_sessions if session.get("waiting_on_user")]
        blocked_sessions = [session for session in live_sessions if session.get("worker_phase") == "blocked"]
        needs_review_sessions = [session for session in live_sessions if session.get("needs_review")]
        lead_session = pending_sessions[0] if pending_sessions else (live_sessions[0] if live_sessions else None)
        if blocked_sessions:
            health = "Needs attention"
        elif pending_sessions:
            health = "Waiting on you"
        elif live_sessions:
            health = "Workers active"
        else:
            health = "Quiet"
        return {
            "open_worker_count": len(live_sessions),
            "pending_decision_count": len(pending_sessions),
            "needs_review_count": len(needs_review_sessions),
            "blocked_worker_count": len(blocked_sessions),
            "health": health,
            "supervisor_summary": lead_session.get("manager_summary") if isinstance(lead_session, dict) else None,
        }


class CommandCenterHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(
        self,
        server_address: tuple[str, int],
        handler_class: type[BaseHTTPRequestHandler],
        *,
        state_store: CommandCenterStateStore,
    ) -> None:
        super().__init__(server_address, handler_class)
        self.state_store = state_store


class _CommandCenterRequestHandler(BaseHTTPRequestHandler):
    server: CommandCenterHTTPServer

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        if path in {"/", "/index.html"}:
            self._write_html(self._index_html())
            return
        if path == "/api/state":
            self._write_json(self.server.state_store.state_payload())
            return
        if path == "/api/events":
            params = parse_qs(parsed.query)
            raw_limit = params.get("limit", ["24"])[0]
            try:
                limit = int(raw_limit)
            except ValueError:
                limit = 24
            self._write_json(self.server.state_store.recent_events_payload(limit=limit))
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Unknown route")

    def do_POST(self) -> None:  # noqa: N802
        try:
            payload = self._read_json_body()
        except ValueError as exc:
            self._write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            return

        try:
            if self.path == "/api/open":
                tool = self._require_text(payload, "tool")
                repo_path = self._require_text(payload, "repo_path")
                self.server.state_store.open_session(
                    tool=tool,
                    repo_path=repo_path,
                    reuse_existing=bool(payload.get("reuse_existing", True)),
                    dangerously_skip_permissions=bool(payload.get("dangerously_skip_permissions", False)),
                )
                self._write_json({"ok": True, "state": self.server.state_store.state_payload()})
                return

            if self.path == "/api/send":
                session_id = self._require_text(payload, "session_id")
                text = self._require_text(payload, "text")
                self.server.state_store.send_to_session(session_id=session_id, text=text)
                self._write_json({"ok": True, "state": self.server.state_store.state_payload()})
                return

            if self.path == "/api/read":
                session_id = self._require_text(payload, "session_id")
                self.server.state_store.read_session(session_id=session_id)
                self._write_json({"ok": True, "state": self.server.state_store.state_payload()})
                return

            if self.path == "/api/close":
                session_id = self._require_text(payload, "session_id")
                self.server.state_store.close_session(session_id=session_id)
                self._write_json({"ok": True, "state": self.server.state_store.state_payload()})
                return
        except Exception as exc:  # pragma: no cover - transport wrapper
            self._write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            return

        self.send_error(HTTPStatus.NOT_FOUND, "Unknown route")

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        return

    def _index_html(self) -> str:
        state_json = json.dumps(self.server.state_store.state_payload()).replace("</", "<\\/")
        template_path = Path(__file__).with_name("command_center_template.html")
        template = template_path.read_text(encoding="utf-8")
        return template.replace("__BOOTSTRAP_JSON__", state_json)

    def _read_json_body(self) -> dict[str, Any]:
        raw_length = self.headers.get("Content-Length")
        try:
            content_length = int(raw_length or "0")
        except ValueError as exc:
            raise ValueError("Invalid Content-Length.") from exc
        raw_body = self.rfile.read(content_length)
        try:
            payload = json.loads(raw_body.decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("Body must be valid JSON.") from exc
        if not isinstance(payload, dict):
            raise ValueError("Body must be a JSON object.")
        return payload

    def _require_text(self, payload: dict[str, Any], key: str) -> str:
        value = payload.get(key)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{key} is required.")
        return value.strip()

    def _write_html(self, body: str, *, status: HTTPStatus = HTTPStatus.OK) -> None:
        encoded = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _write_json(self, payload: dict[str, Any], *, status: HTTPStatus = HTTPStatus.OK) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


class CommandCenterServer:
    def __init__(self, state_store: CommandCenterStateStore) -> None:
        self.state_store = state_store
        self._server: CommandCenterHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self._bound_port: int | None = None

    @property
    def bound_port(self) -> int | None:
        return self._bound_port

    @property
    def url(self) -> str | None:
        if self._bound_port is None:
            return None
        return f"http://127.0.0.1:{self._bound_port}"

    def start_in_background(self, host: str = "127.0.0.1", port: int = 0, *, open_browser: bool = False) -> str:
        if self._thread is not None and self._thread.is_alive():
            existing = self.url
            if existing is None:
                raise RuntimeError("Command center thread is alive without a bound URL.")
            return existing

        server = CommandCenterHTTPServer((host, port), _CommandCenterRequestHandler, state_store=self.state_store)
        thread = threading.Thread(
            target=server.serve_forever,
            name="xr-agent-command-center",
            daemon=True,
        )
        thread.start()

        self._server = server
        self._thread = thread
        self._bound_port = int(server.server_address[1])
        url = self.url
        if url is None:
            raise RuntimeError("Command center did not produce a usable URL.")
        self.state_store.command_center_url = url
        if open_browser:
            webbrowser.open(url)
        return url

    def stop_in_background(self, timeout: float = 5.0) -> None:
        server = self._server
        thread = self._thread
        if server is None or thread is None:
            return
        server.shutdown()
        server.server_close()
        thread.join(timeout=timeout)
        self._server = None
        self._thread = None
        self._bound_port = None
