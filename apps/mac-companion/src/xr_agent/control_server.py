from __future__ import annotations

import json
import socketserver
import threading
from typing import Any, Callable


ControlRequestHandler = Callable[[dict[str, Any]], dict[str, Any]]


class _ThreadingControlServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(
        self,
        server_address: tuple[str, int],
        handler: type[socketserver.StreamRequestHandler],
        *,
        request_handler: ControlRequestHandler | None = None,
    ) -> None:
        super().__init__(server_address, handler)
        self.request_handler = request_handler


class _ControlRequestStreamHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        response: dict[str, Any]
        raw_line = self.rfile.readline()
        if not raw_line:
            return

        try:
            payload = json.loads(raw_line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            response = {"ok": False, "error": "Invalid JSON request."}
        else:
            if not isinstance(payload, dict):
                response = {"ok": False, "error": "Control request payload must be an object."}
            else:
                handler = getattr(self.server, "request_handler", None)
                if handler is None:
                    response = {"ok": False, "error": "No control request handler is configured."}
                else:
                    try:
                        response = handler(payload)
                    except Exception as exc:  # pragma: no cover - defensive transport path
                        response = {"ok": False, "error": str(exc)}

        self.wfile.write((json.dumps(response) + "\n").encode("utf-8"))
        self.wfile.flush()


class ControlServer:
    def __init__(self) -> None:
        self._server: _ThreadingControlServer | None = None
        self._thread: threading.Thread | None = None
        self._bound_port: int | None = None
        self._request_handler: ControlRequestHandler | None = None

    def set_request_handler(self, handler: ControlRequestHandler) -> None:
        self._request_handler = handler
        if self._server is not None:
            self._server.request_handler = handler

    @property
    def bound_port(self) -> int | None:
        return self._bound_port

    def start_in_background(self, host: str, port: int) -> None:
        if self._thread is not None and self._thread.is_alive():
            return

        server = _ThreadingControlServer(
            (host, port),
            _ControlRequestStreamHandler,
            request_handler=self._request_handler,
        )
        thread = threading.Thread(
            target=server.serve_forever,
            name="xr-agent-control-server",
            daemon=True,
        )
        thread.start()

        self._server = server
        self._thread = thread
        self._bound_port = int(server.server_address[1])

    def stop_in_background(self, timeout: float = 5.0) -> None:
        server = self._server
        thread = self._thread
        if server is None or thread is None:
            return

        server.shutdown()
        server.server_close()
        thread.join(timeout=timeout)
        if thread.is_alive():
            raise RuntimeError("control server thread did not stop cleanly")

        self._server = None
        self._thread = None
        self._bound_port = None
