import json
import socketserver
import threading
import urllib.request
from urllib.error import HTTPError

from xr_agent.command_center import (
    CommandCenterControlClient,
    CommandCenterProject,
    CommandCenterServer,
    CommandCenterStateStore,
)


class _FakeControlHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        raw = self.rfile.readline().decode("utf-8")
        payload = json.loads(raw)
        self.server.requests.append(payload)
        action = payload.get("action")
        if action == "list_sessions":
            response = {
                "ok": True,
                "sessions": [
                    {
                        "session_id": "term_demo",
                        "intent": "open_claude_code",
                        "title": "Claude Code",
                        "repo_path": "/tmp/repo",
                        "status": "running",
                        "worker_label": "Claude 1",
                        "task_title": "Review the repo",
                        "worker_phase": "waiting_on_user",
                        "status_text": "Continuing",
                        "manager_summary": "Claude 1 is waiting on you: Should I fix the auth bug now?",
                        "waiting_on_user": True,
                        "needs_review": False,
                        "screen_text": "Claude is reviewing the repo",
                        "command": "claude",
                    }
                ],
            }
        elif action == "recent_events":
            response = {
                "ok": True,
                "events": [
                    {
                        "type": "worker.updated",
                        "ts": "2026-03-21T12:00:00",
                        "session_id": "term_demo",
                        "payload": {"worker_label": "Claude 1"},
                    }
                ],
            }
        else:
            response = {"ok": True, "action": action}
        self.wfile.write((json.dumps(response) + "\n").encode("utf-8"))


class _FakeFailingControlHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        raw = self.rfile.readline().decode("utf-8")
        payload = json.loads(raw)
        self.server.requests.append(payload)
        self.wfile.write((json.dumps({"ok": False, "error": "backend rejected it"}) + "\n").encode("utf-8"))


def test_command_center_serves_state_and_open_action(tmp_path) -> None:
    fake_control = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _FakeControlHandler)
    fake_control.allow_reuse_address = True
    fake_control.requests = []
    thread = threading.Thread(target=fake_control.serve_forever, daemon=True)
    thread.start()

    try:
        control_port = int(fake_control.server_address[1])
        client = CommandCenterControlClient("127.0.0.1", control_port)
        state_store = CommandCenterStateStore(
            control_client=client,
            default_repo_path=str(tmp_path),
            command_center_url="http://127.0.0.1:0",
            saved_projects=[CommandCenterProject(label="Demo", path=str(tmp_path))],
        )
        server = CommandCenterServer(state_store)
        url = server.start_in_background()
        try:
            with urllib.request.urlopen(url + "/api/state") as response:
                payload = json.loads(response.read().decode("utf-8"))
            assert payload["ok"] is True
            assert payload["projects"][0]["path"] == str(tmp_path.resolve())
            assert payload["sessions"][0]["worker_label"] == "Claude 1"
            assert payload["sessions"][0]["worker_phase"] == "waiting_on_user"
            assert payload["overview"]["pending_decision_count"] == 0
            assert "output_tail" not in payload["sessions"][0]

            with urllib.request.urlopen(url + "/api/events?limit=5") as response:
                events_payload = json.loads(response.read().decode("utf-8"))
            assert events_payload["ok"] is True
            assert events_payload["events"][0]["type"] == "worker.updated"

            request = urllib.request.Request(
                url + "/api/open",
                data=json.dumps(
                    {"tool": "claude", "repo_path": str(tmp_path), "reuse_existing": True}
                ).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(request) as response:
                opened = json.loads(response.read().decode("utf-8"))
            assert opened["ok"] is True
            assert opened["state"]["current_project"] == str(tmp_path.resolve())
            open_request = next(
                request
                for request in reversed(fake_control.requests)
                if request.get("action") == "open_session"
            )
            assert open_request["dangerously_skip_permissions"] is False

            unsafe_request = urllib.request.Request(
                url + "/api/open",
                data=json.dumps(
                    {
                        "tool": "claude",
                        "repo_path": str(tmp_path),
                        "reuse_existing": True,
                        "dangerously_skip_permissions": True,
                    }
                ).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(unsafe_request) as response:
                unsafe_opened = json.loads(response.read().decode("utf-8"))
            assert unsafe_opened["ok"] is True
            unsafe_open_request = next(
                request
                for request in reversed(fake_control.requests)
                if request.get("action") == "open_session"
            )
            assert unsafe_open_request["dangerously_skip_permissions"] is True
        finally:
            server.stop_in_background()
    finally:
        fake_control.shutdown()
        fake_control.server_close()


def test_command_center_does_not_mutate_project_on_failed_open(tmp_path) -> None:
    fake_control = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _FakeFailingControlHandler)
    fake_control.allow_reuse_address = True
    fake_control.requests = []
    thread = threading.Thread(target=fake_control.serve_forever, daemon=True)
    thread.start()

    try:
        control_port = int(fake_control.server_address[1])
        client = CommandCenterControlClient("127.0.0.1", control_port)
        state_store = CommandCenterStateStore(
            control_client=client,
            default_repo_path=str(tmp_path),
            command_center_url="http://127.0.0.1:0",
            saved_projects=[CommandCenterProject(label="Demo", path=str(tmp_path))],
        )
        server = CommandCenterServer(state_store)
        url = server.start_in_background()
        other_repo = tmp_path / "other"
        other_repo.mkdir()
        try:
            request = urllib.request.Request(
                url + "/api/open",
                data=json.dumps(
                    {"tool": "claude", "repo_path": str(other_repo), "reuse_existing": True}
                ).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                urllib.request.urlopen(request)
            except HTTPError as exc:
                payload = json.loads(exc.read().decode("utf-8"))
            else:
                raise AssertionError("Expected /api/open to fail when backend rejects the request")
            assert payload["ok"] is False
            assert state_store.default_repo_path == str(tmp_path.resolve())
            assert [project.path for project in state_store.saved_projects] == [str(tmp_path.resolve())]
        finally:
            server.stop_in_background()
    finally:
        fake_control.shutdown()
        fake_control.server_close()
