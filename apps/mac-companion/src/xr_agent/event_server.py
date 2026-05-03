from __future__ import annotations

import asyncio
import json
import threading
from collections import deque
from concurrent.futures import TimeoutError as FutureTimeoutError
from datetime import datetime
from typing import Any, Callable

from xr_agent.models import AgentEvent

try:  # pragma: no cover - optional dependency at runtime
    import websockets
    from websockets.exceptions import ConnectionClosed
except ImportError:  # pragma: no cover - optional dependency at runtime
    websockets = None
    ConnectionClosed = Exception  # type: ignore[assignment]


class EventServer:
    _REPLAY_EXCLUDED_TYPES = {"session.output", "terminal.output", "terminal.screen"}

    def __init__(self, max_events: int = 100) -> None:
        self._events: deque[AgentEvent] = deque(maxlen=max_events)
        self._events_lock = threading.Lock()
        self._subscribers: set[asyncio.Queue[str | None]] = set()
        self._subscribers_lock = threading.Lock()
        self._server: Any | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._bound_port: int | None = None
        self._message_handler: Callable[[dict[str, Any]], None] | None = None

    def set_message_handler(self, handler: Callable[[dict[str, Any]], None]) -> None:
        self._message_handler = handler

    async def start(self, host: str, port: int) -> None:
        if websockets is None:
            raise RuntimeError("websockets is required to start the event server")
        self._loop = asyncio.get_running_loop()
        self._server = await websockets.serve(self._handle_client, host, port)
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
        with self._events_lock:
            self._events.append(event)
        wire_message = json.dumps(self.serialize_event(event))
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
        with self._subscribers_lock:
            self._subscribers.add(queue)
        with self._events_lock:
            replay_events = [
                event for event in self._events
                if event.event_type not in self._REPLAY_EXCLUDED_TYPES
            ]
        sender_task: asyncio.Task[None] | None = None
        try:
            sender_task = asyncio.create_task(self._send_queue_messages(websocket, queue))
            for event in replay_events:
                self._enqueue_message(queue, json.dumps(self.serialize_event(event)))
            async for raw_message in websocket:
                # Keep the websocket loop responsive even when the app handler does
                # heavier work like launching or routing coding sessions.
                await asyncio.to_thread(self._handle_client_message, raw_message)
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

    def _handle_client_message(self, raw_message: Any) -> None:
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

        handler(payload)


def make_event(event_type: str, session_id: str | None, payload: dict[str, Any]) -> AgentEvent:
    return AgentEvent(event_type=event_type, ts=datetime.now(), session_id=session_id, payload=payload)
