from __future__ import annotations

import asyncio
import inspect
import json
import os
import ssl
import threading
from collections import deque
from concurrent.futures import TimeoutError as FutureTimeoutError
from dataclasses import replace
from datetime import datetime
from typing import Any, Callable

from xr_agent.device_pairing import DevicePairingAuth
from xr_agent.models import AgentEvent

try:  # pragma: no cover - optional dependency at runtime
    import websockets
    from websockets.exceptions import ConnectionClosed
except ImportError:  # pragma: no cover - optional dependency at runtime
    websockets = None
    ConnectionClosed = Exception  # type: ignore[assignment]


class EventServer:
    _MAX_LIVE_EVENT_BYTES = 256 * 1024
    _MAX_REPLAY_EVENT_BYTES = 16 * 1024
    _MAX_LIVE_STRING_CHARS = 24 * 1024
    _MAX_HISTORY_STRING_CHARS = 4 * 1024
    _MAX_LIVE_AUDIO_BASE64_CHARS = 128 * 1024
    _MAX_LIST_ITEMS = 80
    _STRING_FIELD_LIMITS = {
        "line": 2048,
        "screen_text": 12000,
        "text": 4096,
        "summary": 4096,
        "manager_summary": 1200,
        "status_text": 600,
        "pending_question": 1200,
        "question": 1200,
        "last_update": 1200,
        "output_summary": 1200,
        "sdp": 12000,
        "client_secret": 4096,
    }
    _REPLAY_EXCLUDED_TYPES = {
        "avatar.speaking",
        "session.output",
        "terminal.output",
        "terminal.screen",
        "voice.realtime.session",
        "voice.realtime.sdp.answer",
    }

    def __init__(
        self,
        max_events: int = 100,
        *,
        auth: DevicePairingAuth | None = None,
    ) -> None:
        self._events: deque[AgentEvent] = deque(maxlen=max_events)
        self._events_lock = threading.Lock()
        self._subscribers: set[asyncio.Queue[str | None]] = set()
        self._subscribers_lock = threading.Lock()
        self._server: Any | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._bound_port: int | None = None
        self._message_handler: Callable[..., None] | None = None
        self._message_handler_accepts_reply = False
        self.auth = auth

    def set_message_handler(self, handler: Callable[..., None]) -> None:
        self._message_handler = handler
        self._message_handler_accepts_reply = len(inspect.signature(handler).parameters) >= 2

    async def start(self, host: str, port: int) -> None:
        if websockets is None:
            raise RuntimeError("websockets is required to start the event server")
        self._loop = asyncio.get_running_loop()
        ssl_context = None
        cert_path = os.environ.get("XR_AGENT_WSS_CERT", "").strip()
        key_path = os.environ.get("XR_AGENT_WSS_KEY", "").strip()
        if cert_path or key_path:
            if not cert_path or not key_path:
                raise RuntimeError("XR_AGENT_WSS_CERT and XR_AGENT_WSS_KEY must be set together")
            ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ssl_context.load_cert_chain(cert_path, key_path)
        self._server = await websockets.serve(self._handle_client, host, port, ssl=ssl_context)
        sockets = getattr(self._server, "sockets", None) or []
        self._bound_port = int(sockets[0].getsockname()[1]) if sockets else port

    async def stop(self) -> None:
        if self._server is None:
            return
        with self._subscribers_lock:
            subscribers = list(self._subscribers)
        for queue in subscribers:
            self._enqueue_message(queue, None)
        self._server.close()
        await self._server.wait_closed()
        self._server = None
        self._bound_port = None

    def start_in_background(self, host: str, port: int) -> None:
        if self._thread is not None and self._thread.is_alive():
            return

        ready = threading.Event()
        error: list[BaseException] = []
        loop = asyncio.new_event_loop()

        def run() -> None:
            asyncio.set_event_loop(loop)
            try:
                loop.run_until_complete(self.start(host, port))
            except BaseException as exc:
                error.append(exc)
                ready.set()
                return
            ready.set()
            loop.run_forever()
            loop.run_until_complete(loop.shutdown_asyncgens())
            loop.close()

        thread = threading.Thread(target=run, name="xr-agent-event-server", daemon=True)
        thread.start()
        ready.wait()
        if error:
            thread.join(timeout=1)
            if isinstance(error[0], OSError) and getattr(error[0], "errno", None) == 48:
                raise RuntimeError(
                    f"failed to start event server: port {port} is already in use"
                ) from error[0]
            raise RuntimeError("failed to start event server") from error[0]
        self._loop = loop
        self._thread = thread

    def stop_in_background(self, timeout: float = 5.0) -> None:
        loop = self._loop
        thread = self._thread
        if loop is None or thread is None:
            return

        future = asyncio.run_coroutine_threadsafe(self.stop(), loop)
        try:
            future.result(timeout=timeout)
        except FutureTimeoutError as exc:
            raise RuntimeError("timed out while stopping event server") from exc
        finally:
            loop.call_soon_threadsafe(loop.stop)
            thread.join(timeout=timeout)
            if thread.is_alive():
                raise RuntimeError("event server thread did not stop cleanly")
            self._loop = None
            self._thread = None

    def publish(self, event: AgentEvent) -> None:
        history_event = self._history_event(event)
        live_event = self._live_event(event)
        with self._events_lock:
            self._events.append(history_event)
        wire_message = self._wire_message(live_event, max_bytes=self._MAX_LIVE_EVENT_BYTES)
        with self._subscribers_lock:
            subscribers = list(self._subscribers)
        for queue in subscribers:
            self._publish_to_queue(queue, wire_message)

    @property
    def bound_port(self) -> int | None:
        return self._bound_port

    def recent(self) -> list[AgentEvent]:
        with self._events_lock:
            return list(self._events)

    def recent_serialized(self) -> list[dict[str, Any]]:
        with self._events_lock:
            return [self.serialize_event(event) for event in self._events]

    def serialize_event(self, event: AgentEvent) -> dict[str, Any]:
        return {
            "type": event.event_type,
            "ts": event.ts.isoformat(),
            "session_id": event.session_id,
            "payload": event.payload,
        }

    def _live_event(self, event: AgentEvent) -> AgentEvent:
        payload = self._sanitize_payload(event.payload, keep_audio=True)
        return replace(event, payload=payload)

    def _history_event(self, event: AgentEvent) -> AgentEvent:
        payload = self._sanitize_payload(event.payload, keep_audio=False)
        return replace(event, payload=payload)

    def _sanitize_payload(self, payload: dict[str, Any], *, keep_audio: bool) -> dict[str, Any]:
        sanitized: dict[str, Any] = {}
        for key, value in payload.items():
            if key == "audio_base64":
                if keep_audio and isinstance(value, str) and len(value) <= self._MAX_LIVE_AUDIO_BASE64_CHARS:
                    sanitized[key] = value
                else:
                    sanitized["audio_base64_stripped"] = True
                    sanitized["audio_base64_marker"] = self._stripped_marker(
                        "audio_base64",
                        len(value) if isinstance(value, str) else 0,
                    )
                continue
            sanitized[key] = self._sanitize_value(value, field_name=key, keep_audio=keep_audio)
        return sanitized

    def _sanitize_value(self, value: Any, *, field_name: str, keep_audio: bool) -> Any:
        if isinstance(value, str):
            limit = self._STRING_FIELD_LIMITS.get(
                field_name,
                self._MAX_LIVE_STRING_CHARS if keep_audio else self._MAX_HISTORY_STRING_CHARS,
            )
            return self._truncate_string(value, limit, field_name)
        if isinstance(value, dict):
            sanitized: dict[str, Any] = {}
            for key, item in list(value.items())[: self._MAX_LIST_ITEMS]:
                field_key = str(key)
                if field_key == "audio_base64":
                    if keep_audio and isinstance(item, str) and len(item) <= self._MAX_LIVE_AUDIO_BASE64_CHARS:
                        sanitized[field_key] = item
                    else:
                        sanitized["audio_base64_stripped"] = True
                        sanitized["audio_base64_marker"] = self._stripped_marker(
                            "audio_base64",
                            len(item) if isinstance(item, str) else 0,
                        )
                    continue
                sanitized[field_key] = self._sanitize_value(item, field_name=field_key, keep_audio=keep_audio)
            return sanitized
        if isinstance(value, list):
            items = value[: self._MAX_LIST_ITEMS]
            sanitized_items = [
                self._sanitize_value(item, field_name=field_name, keep_audio=keep_audio)
                for item in items
            ]
            if len(value) > self._MAX_LIST_ITEMS:
                sanitized_items.append(
                    self._stripped_marker(field_name, len(value), unit="items")
                )
            return sanitized_items
        return value

    def _truncate_string(self, value: str, limit: int, field_name: str) -> str:
        if len(value) <= limit:
            return value
        marker = self._stripped_marker(field_name, len(value))
        keep = max(0, limit - len(marker) - 1)
        return f"{value[:keep].rstrip()} {marker}".strip()

    def _stripped_marker(self, field_name: str, original_size: int, *, unit: str = "chars") -> str:
        return f"[stripped oversized {field_name}: original_{unit}={original_size}]"

    def _wire_message(self, event: AgentEvent, *, max_bytes: int) -> str:
        payload = self.serialize_event(event)
        wire_message = json.dumps(payload, separators=(",", ":"))
        if len(wire_message.encode("utf-8")) <= max_bytes:
            return wire_message
        compact_payload = {
            "payload_stripped": True,
            "payload_marker": f"[stripped oversized event payload: original_bytes={len(wire_message.encode('utf-8'))}]",
        }
        compact_event = replace(event, payload=compact_payload)
        return json.dumps(self.serialize_event(compact_event), separators=(",", ":"))

    def _should_replay(self, event: AgentEvent) -> bool:
        if event.event_type in self._REPLAY_EXCLUDED_TYPES:
            return False
        if self._contains_audio_payload(event.payload):
            return False
        wire_message = self._wire_message(event, max_bytes=self._MAX_REPLAY_EVENT_BYTES)
        if len(wire_message.encode("utf-8")) > self._MAX_REPLAY_EVENT_BYTES:
            return False
        return True

    def _contains_audio_payload(self, value: Any) -> bool:
        if isinstance(value, dict):
            if "audio_base64" in value or value.get("audio_base64_stripped") is True:
                return True
            return any(self._contains_audio_payload(item) for item in value.values())
        if isinstance(value, list):
            return any(self._contains_audio_payload(item) for item in value)
        return False

    def _publish_to_queue(self, queue: asyncio.Queue[str | None], wire_message: str) -> None:
        loop = self._loop
        if loop is not None and loop.is_running():
            loop.call_soon_threadsafe(self._enqueue_message, queue, wire_message)
            return
        self._enqueue_message(queue, wire_message)

    def _enqueue_message(self, queue: asyncio.Queue[str | None], wire_message: str | None) -> None:
        try:
            queue.put_nowait(wire_message)
        except asyncio.QueueFull:
            with self._subscribers_lock:
                self._subscribers.discard(queue)

    async def _handle_client(self, websocket: Any) -> None:
        queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=200)
        if self.auth is not None:
            request = getattr(websocket, "request", None)
            path = getattr(request, "path", None) or getattr(websocket, "path", "")
            grant = self.auth.authenticate_path(path)
            if grant is None:
                await websocket.close(code=4401, reason="pairing or device token required")
                return
            if grant.device_token is not None:
                paired = make_event("auth.paired", None, {"device_token": grant.device_token})
                self._enqueue_message(queue, self._wire_message(paired, max_bytes=self._MAX_LIVE_EVENT_BYTES))
        with self._subscribers_lock:
            self._subscribers.add(queue)
        with self._events_lock:
            replay_events = [
                event for event in self._events
                if self._should_replay(event)
            ]
        sender_task: asyncio.Task[None] | None = None
        try:
            sender_task = asyncio.create_task(self._send_queue_messages(websocket, queue))
            for event in replay_events:
                self._enqueue_message(queue, self._wire_message(event, max_bytes=self._MAX_REPLAY_EVENT_BYTES))
            async for raw_message in websocket:
                # Keep the websocket loop responsive even when the app handler does
                # heavier work like launching or routing coding sessions.
                await asyncio.to_thread(self._handle_client_message, raw_message, queue)
        except ConnectionClosed:
            pass
        finally:
            if sender_task is not None:
                self._enqueue_message(queue, None)
                await asyncio.gather(sender_task, return_exceptions=True)
            with self._subscribers_lock:
                self._subscribers.discard(queue)

    async def _send_queue_messages(self, websocket: Any, queue: asyncio.Queue[str | None]) -> None:
        while True:
            message = await queue.get()
            if message is None:
                break
            try:
                await websocket.send(message)
            except ConnectionClosed:
                break

    def _handle_client_message(self, raw_message: Any, queue: asyncio.Queue[str | None] | None = None) -> None:
        handler = self._message_handler
        if handler is None:
            return

        if isinstance(raw_message, bytes):
            try:
                raw_message = raw_message.decode("utf-8")
            except UnicodeDecodeError:
                return

        if not isinstance(raw_message, str):
            return

        try:
            payload = json.loads(raw_message)
        except json.JSONDecodeError:
            return

        if not isinstance(payload, dict):
            return

        if self._message_handler_accepts_reply:
            def reply(event: AgentEvent) -> None:
                if queue is not None:
                    self._publish_to_queue(queue, self._wire_message(event, max_bytes=self._MAX_LIVE_EVENT_BYTES))

            handler(payload, reply)
        else:
            handler(payload)


def make_event(event_type: str, session_id: str | None, payload: dict[str, Any]) -> AgentEvent:
    return AgentEvent(event_type=event_type, ts=datetime.now(), session_id=session_id, payload=payload)
