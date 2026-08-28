#!/usr/bin/env python3
"""Authenticated Mobile Yuki <-> OpenAI Realtime audio relay.

The iPhone sends 48 kHz mono PCM16 frames over an authenticated LAN WebSocket.
OpenAI credentials stay on the Mac. Assistant PCM returns on the same socket.
Substantial actions delegate to the same durable Hermes worker store as Voice Hermy.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import hmac
import json
import os
import secrets
import signal
import sys
from fractions import Fraction
from pathlib import Path
from typing import Any, Optional
from urllib.parse import parse_qs, urlparse

import aiohttp
import av
import websockets
from aiortc import MediaStreamTrack, RTCPeerConnection, RTCSessionDescription

HOME = Path.home()
FACE_SERVICE = HOME / ".hermes/services/facetime-realtime"
if str(FACE_SERVICE) not in sys.path:
    sys.path.insert(0, str(FACE_SERVICE))

import facetime_realtime as voice_runtime  # noqa: E402
from voice_jobs import VoiceJobStore  # noqa: E402

MODEL = "gpt-realtime-2.1"
API_URL = f"https://api.openai.com/v1/realtime/calls?model={MODEL}"
DEFAULT_TOKEN_FILE = HOME / ".hermes/services/mobile-yuki-realtime/token"
DEFAULT_LOG = HOME / ".hermes/logs/mobile-yuki-realtime.log"
INPUT_AUDIO = 0x01
OUTPUT_AUDIO = 0x02
SAMPLE_RATE = 48_000
FRAME_SAMPLES = 960
FRAME_BYTES = FRAME_SAMPLES * 2
MAX_AUDIO_MESSAGE = SAMPLE_RATE * 2 * 2  # at most two seconds of mono PCM16


def log(event: str, **fields: Any) -> None:
    DEFAULT_LOG.parent.mkdir(parents=True, exist_ok=True)
    safe = {"event": event, **fields}
    line = json.dumps(safe, ensure_ascii=False, sort_keys=True)
    print(line, flush=True)
    with DEFAULT_LOG.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def ensure_token(path: Path) -> str:
    """Load or atomically create a strong local pairing token."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        token = path.read_text(encoding="utf-8").strip()
        if len(token) < 32:
            raise RuntimeError(f"Mobile Yuki token at {path} is too short")
        os.chmod(path, 0o600)
        return token
    token = secrets.token_urlsafe(32)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(token + "\n", encoding="utf-8")
    os.chmod(temp, 0o600)
    os.replace(temp, path)
    return token


def token_fingerprint(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:12]


def authenticated_path(path: str, expected_token: str) -> bool:
    supplied = (parse_qs(urlparse(path).query).get("token") or [""])[0]
    return bool(supplied) and hmac.compare_digest(supplied, expected_token)


def authenticated_request(path: str, authorization: str, expected_token: str) -> bool:
    prefix = "Bearer "
    if authorization.startswith(prefix):
        supplied = authorization[len(prefix):].strip()
        if supplied and hmac.compare_digest(supplied, expected_token):
            return True
    # Temporary compatibility for older browser/non-native clients. Native
    # Mobile Yuki uses the Authorization header so tokens don't enter WS URLs.
    return authenticated_path(path, expected_token)


class PCMQueueTrack(MediaStreamTrack):
    kind = "audio"

    def __init__(self, queue: "asyncio.Queue[bytes]") -> None:
        super().__init__()
        self.queue = queue
        self.pending = bytearray()
        self.pts = 0

    async def recv(self) -> av.AudioFrame:
        while len(self.pending) < FRAME_BYTES:
            try:
                chunk = await asyncio.wait_for(self.queue.get(), timeout=0.10)
                self.pending.extend(chunk)
            except asyncio.TimeoutError:
                self.pending.extend(bytes(FRAME_BYTES - len(self.pending)))
        pcm = bytes(self.pending[:FRAME_BYTES])
        del self.pending[:FRAME_BYTES]
        frame = av.AudioFrame(format="s16", layout="mono", samples=FRAME_SAMPLES)
        frame.planes[0].update(pcm)
        frame.sample_rate = SAMPLE_RATE
        frame.pts = self.pts
        frame.time_base = Fraction(1, SAMPLE_RATE)
        self.pts += FRAME_SAMPLES
        return frame


class MobileRealtimePeer:
    def __init__(self, client: "MobileClient") -> None:
        self.client = client
        self.pc = RTCPeerConnection()
        self.dc = self.pc.createDataChannel("oai-events")
        self.opened = asyncio.Event()
        self.stopped = asyncio.Event()
        self.track = PCMQueueTrack(client.audio_queue)
        self.tasks: set[asyncio.Task[Any]] = set()
        self.handled_calls: set[str] = set()
        self.resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)

    def spawn(self, coroutine: Any) -> None:
        task = asyncio.create_task(coroutine)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def send_json(self, payload: dict[str, Any]) -> None:
        await self.client.websocket.send(json.dumps(payload, separators=(",", ":")))

    def session_config(self) -> dict[str, Any]:
        handoff = self.client.store.resume_brief()
        tools = [
            {
                "type": "function",
                "name": "save_session_note",
                "description": "Persist one concise important cross-session decision, update, blocker, or next action.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "category": {
                            "type": "string",
                            "enum": ["decisions", "task_updates", "blockers", "next_actions"],
                        },
                        "note": {"type": "string"},
                    },
                    "required": ["category", "note"],
                    "additionalProperties": False,
                },
            },
            {
                "type": "function",
                "name": "request_callback",
                "description": "Schedule one explicit FaceTime callback after a named task or all active tasks finish.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "task_name": {"type": "string"},
                        "reason": {"type": "string"},
                    },
                    "required": ["task_name", "reason"],
                    "additionalProperties": False,
                },
            },
        ]
        if voice_runtime.ask_hermes is not None:
            tools.append(
                {
                    "type": "function",
                    "name": "ask_hermy",
                    "description": (
                        "Create or continue a named durable full-Hermes task with Mac tools. "
                        "Use separate stable task names for independent work and reuse names for follow-ups. "
                        "For browser work, if Chrome remote debugging is blocked, require Hermes to try macOS "
                        "Computer Use on the existing Chrome window before reporting browser access unavailable."
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "request": {"type": "string"},
                            "task_name": {"type": "string"},
                            "new_task": {"type": "boolean"},
                        },
                        "required": ["request", "task_name", "new_task"],
                        "additionalProperties": False,
                    },
                }
            )
        return {
            "type": "session.update",
            "session": {
                "type": "realtime",
                "output_modalities": ["audio"],
                "instructions": (
                    "You are Hermy embodied as Mobile Yuki in Bless's private iPhone AR session. Be warm, natural, "
                    "fast, concise, and aware that your body is standing in the room through AR. You are backed by the "
                    "same full Hermes Agent and Mac tools as text Hermy. For actions, research, files, coding, browser, "
                    "computer control, memory, skills, cron, or subagents, call ask_hermy instead of claiming you lack "
                    "access. Only report a limitation after a real tool result identifies the exact blocker. Durable jobs "
                    "survive this mobile session. Answer update questions directly from the handoff. Preserve normal "
                    "approval rules for consequential actions. Save only material notes. The user may interrupt naturally.\n" + handoff
                    + "\nBrowser routing: prefer structured browser automation when authorized. If Chrome asks to Allow "
                    "remote debugging, do not repeatedly retry or claim all browser control is unavailable. Delegate to "
                    "Hermes and require a macOS Computer Use attempt against the user's existing Chrome window. Report a "
                    "blocker only if both structured browser automation and Computer Use fail."
                    + "\nTurn-taking rule: respond only after a clear, meaningful human utterance. Never answer silence, "
                    "ambient noise, speaker echo, breathing, isolated filler sounds, or partial fragments. Do not continue "
                    "talking without a new user turn."
                ),
                "audio": {
                    "input": {
                        "transcription": {"model": "gpt-4o-mini-transcribe"},
                        "turn_detection": {
                            "type": "server_vad",
                            "threshold": 0.82,
                            "prefix_padding_ms": 400,
                            "silence_duration_ms": 1000,
                            "create_response": True,
                            "interrupt_response": True,
                        },
                    },
                    "output": {"voice": "marin"},
                },
                "tools": tools,
                "tool_choice": "auto",
            },
        }

    async def consult_hermy(self, call_id: str, raw_arguments: str) -> None:
        if call_id in self.handled_calls:
            return
        self.handled_calls.add(call_id)
        try:
            args = json.loads(raw_arguments or "{}")
            request = str(args.get("request") or "").strip()
            task_name = str(args.get("task_name") or "").strip()
            if not request or not task_name:
                raise ValueError("request and task_name are required")
            job = self.client.store.enqueue(request, task_name=task_name, new_task=bool(args.get("new_task", False)))
            output = f"Durable Mobile Yuki task '{job['task_name']}' job {job['id']} is queued and survives disconnects."
            self.spawn(self.watch_job(job["id"]))
            log("hermy_job_queued", job_id=job["id"], task_id=job["task_id"])
        except Exception as exc:
            output = f"Hermy task could not be queued: {exc}"
            log("hermy_job_queue_failed", detail=str(exc))
        self.dc.send(json.dumps({
            "type": "conversation.item.create",
            "item": {"type": "function_call_output", "call_id": call_id, "output": output},
        }))
        self.dc.send(json.dumps({"type": "response.create"}))

    def save_note(self, call_id: str, raw_arguments: str) -> None:
        if call_id in self.handled_calls:
            return
        self.handled_calls.add(call_id)
        try:
            args = json.loads(raw_arguments or "{}")
            self.client.store.add_call_note(
                self.client.call_id,
                str(args.get("category") or ""),
                str(args.get("note") or "").strip(),
            )
            output = "Saved to the concise cross-session notes."
        except Exception as exc:
            output = f"The note could not be saved: {exc}"
        self.dc.send(json.dumps({
            "type": "conversation.item.create",
            "item": {"type": "function_call_output", "call_id": call_id, "output": output},
        }))
        self.dc.send(json.dumps({"type": "response.create"}))

    def schedule_callback(self, call_id: str, raw_arguments: str) -> None:
        if call_id in self.handled_calls:
            return
        self.handled_calls.add(call_id)
        try:
            args = json.loads(raw_arguments or "{}")
            callback = self.client.store.request_callback(
                str(args.get("task_name") or "").strip(),
                str(args.get("reason") or "").strip(),
            )
            output = f"Authorized callback {callback['id']} is durably scheduled for {callback['task_label']}."
        except Exception as exc:
            output = f"The callback could not be scheduled: {exc}"
        self.dc.send(json.dumps({
            "type": "conversation.item.create",
            "item": {"type": "function_call_output", "call_id": call_id, "output": output},
        }))
        self.dc.send(json.dumps({"type": "response.create"}))

    async def watch_job(self, job_id: str) -> None:
        while self.dc.readyState == "open" and not self.stopped.is_set():
            await asyncio.sleep(2)
            try:
                job = self.client.store.load_job(job_id)
            except (OSError, ValueError):
                continue
            if job.get("status") not in {"completed", "failed"}:
                continue
            outcome = job.get("result") if job.get("status") == "completed" else job.get("error")
            self.dc.send(json.dumps({
                "type": "conversation.item.create",
                "item": {
                    "type": "message",
                    "role": "user",
                    "content": [{
                        "type": "input_text",
                        "text": (
                            f"AUTHORITATIVE COMPLETION: Background task {job['task_name']} {job['status']}. "
                            f"Report this result to Bless once, then stop: {outcome}"
                        ),
                    }],
                },
            }))
            self.dc.send(json.dumps({
                "type": "response.create",
                "response": {
                    "tool_choice": "none",
                    "instructions": (
                        "Speak one concise completion update from the authoritative result. Do not call tools, "
                        "enqueue another job, retry the task, ask for status, or continue speaking afterward."
                    ),
                },
            }))
            self.client.store.mark_reported(job_id)
            return

    async def consume_output(self, track: MediaStreamTrack) -> None:
        await self.send_json({"type": "mobile.realtime.output_started"})
        try:
            while not self.stopped.is_set():
                frame = await track.recv()
                for converted in self.resampler.resample(frame):
                    pcm = converted.to_ndarray().tobytes()
                    await self.client.websocket.send(bytes([OUTPUT_AUDIO]) + pcm)
        except Exception as exc:
            log("remote_audio_ended", detail=str(exc))

    def handle_provider_event(self, event: dict[str, Any]) -> None:
        kind = str(event.get("type") or "")
        if kind == "error" and (event.get("error") or {}).get("code") == "session_expired":
            self.stopped.set()
        if kind in {
            "input_audio_buffer.speech_started",
            "input_audio_buffer.speech_stopped",
            "conversation.item.input_audio_transcription.completed",
            "response.output_audio_transcript.delta",
            "response.output_audio_transcript.done",
            "response.done",
            "error",
        }:
            payload: dict[str, Any] = {"type": "mobile.provider_event", "provider_type": kind}
            if kind.endswith("transcription.completed") or kind.endswith("transcript.done"):
                payload["transcript"] = event.get("transcript") or ""
            elif kind.endswith("transcript.delta"):
                payload["delta"] = event.get("delta") or ""
            elif kind == "error":
                payload["detail"] = (event.get("error") or {}).get("message") or "Realtime provider error"
            self.spawn(self.send_json(payload))
        if kind == "conversation.item.input_audio_transcription.completed":
            self.client.store.append_turn("Bless", event.get("transcript") or "")
        elif kind == "response.output_audio_transcript.done":
            self.client.store.append_turn("Hermy", event.get("transcript") or "")
        if kind == "response.function_call_arguments.done":
            self.dispatch_function(event.get("name"), event.get("call_id"), event.get("arguments", "{}"))
        elif kind == "response.output_item.done":
            item = event.get("item") or {}
            if item.get("type") == "function_call":
                self.dispatch_function(item.get("name"), item.get("call_id"), item.get("arguments", "{}"))

    def dispatch_function(self, name: Any, call_id: Any, arguments: str) -> None:
        if not isinstance(call_id, str):
            return
        if name == "ask_hermy":
            self.spawn(self.consult_hermy(call_id, arguments))
        elif name == "save_session_note":
            self.save_note(call_id, arguments)
        elif name == "request_callback":
            self.schedule_callback(call_id, arguments)

    async def run(self) -> None:
        @self.dc.on("open")
        def on_open() -> None:
            self.dc.send(json.dumps(self.session_config()))
            self.opened.set()

        @self.dc.on("message")
        def on_message(message: Any) -> None:
            if not isinstance(message, str):
                return
            with contextlib.suppress(json.JSONDecodeError):
                self.handle_provider_event(json.loads(message))

        @self.pc.on("track")
        def on_track(track: MediaStreamTrack) -> None:
            if track.kind == "audio":
                self.spawn(self.consume_output(track))

        @self.pc.on("connectionstatechange")
        async def on_connectionstatechange() -> None:
            if self.pc.connectionState in {"failed", "closed", "disconnected"}:
                self.stopped.set()

        self.pc.addTrack(self.track)
        offer = await self.pc.createOffer()
        await self.pc.setLocalDescription(offer)
        token, account = voice_runtime.oauth()
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/sdp",
            "Accept": "application/sdp",
            "chatgpt-account-id": account,
        }
        async with aiohttp.ClientSession() as session:
            async with session.post(API_URL, headers=headers, data=self.pc.localDescription.sdp, timeout=45) as response:
                answer = await response.text()
                if response.status != 201 or not answer.startswith("v=0"):
                    raise RuntimeError(f"Realtime OAuth session failed: HTTP {response.status}: {answer[:240]}")
        await self.pc.setRemoteDescription(RTCSessionDescription(sdp=answer, type="answer"))
        await asyncio.wait_for(self.opened.wait(), timeout=30)
        await self.send_json({"type": "mobile.realtime.ready", "model": MODEL, "hermy_tools": voice_runtime.ask_hermes is not None})
        log("mobile_realtime_ready", model=MODEL, hermy_tools=voice_runtime.ask_hermes is not None)
        await self.stopped.wait()

    async def close(self) -> None:
        self.stopped.set()
        for task in list(self.tasks):
            task.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)
        await self.pc.close()
        self.track.stop()


class MobileClient:
    def __init__(self, websocket: Any) -> None:
        self.websocket = websocket
        self.audio_queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=200)
        self.store = VoiceJobStore()
        self.call_id = self.store.begin_call()
        self.active_peer: Optional[MobileRealtimePeer] = None
        self.closed = asyncio.Event()

    async def receive(self) -> None:
        try:
            async for message in self.websocket:
                if isinstance(message, bytes):
                    if not message or message[0] != INPUT_AUDIO:
                        continue
                    pcm = message[1:]
                    if not pcm or len(pcm) % 2 or len(pcm) > MAX_AUDIO_MESSAGE:
                        await self.websocket.send(json.dumps({"type": "mobile.realtime.error", "detail": "Invalid PCM frame"}))
                        continue
                    if self.audio_queue.full():
                        with contextlib.suppress(asyncio.QueueEmpty):
                            self.audio_queue.get_nowait()
                    self.audio_queue.put_nowait(pcm)
                    continue
                try:
                    event = json.loads(message)
                except (TypeError, json.JSONDecodeError):
                    continue
                if event.get("type") == "mobile.realtime.cancel" and self.active_peer and self.active_peer.dc.readyState == "open":
                    self.active_peer.dc.send(json.dumps({"type": "response.cancel"}))
                elif event.get("type") == "mobile.text_command":
                    text = str(event.get("text") or "").strip()
                    if not text:
                        await self.websocket.send(json.dumps({"type": "mobile.text_command.failed", "detail": "Command was empty"}))
                        continue
                    job = self.store.enqueue(text, task_name="Mobile Yuki", new_task=False)
                    await self.websocket.send(json.dumps({
                        "type": "mobile.text_command.queued",
                        "job_id": job["id"],
                        "task_name": job["task_name"],
                    }))
                    if self.active_peer:
                        self.active_peer.spawn(self.active_peer.watch_job(job["id"]))
        finally:
            self.closed.set()

    async def run(self) -> None:
        recovered = self.store.recover()
        if recovered:
            log("hermy_jobs_recovered", count=len(recovered))
        receiver = asyncio.create_task(self.receive())
        try:
            while not self.closed.is_set():
                peer = MobileRealtimePeer(self)
                self.active_peer = peer
                provider = asyncio.create_task(peer.run())
                done, _ = await asyncio.wait({provider, receiver}, return_when=asyncio.FIRST_COMPLETED)
                if receiver in done:
                    provider.cancel()
                    await asyncio.gather(provider, return_exceptions=True)
                    await peer.close()
                    break
                error = provider.exception()
                await peer.close()
                if error:
                    log("provider_cycle_failed", detail=str(error))
                    await self.websocket.send(json.dumps({"type": "mobile.realtime.reconnecting", "detail": str(error)}))
                else:
                    await self.websocket.send(json.dumps({"type": "mobile.realtime.reconnecting", "detail": "Provider session recycling"}))
                await asyncio.sleep(2)
        finally:
            receiver.cancel()
            await asyncio.gather(receiver, return_exceptions=True)
            if self.active_peer:
                await self.active_peer.close()
            with contextlib.suppress(Exception):
                self.store.finish_call(self.call_id)


class Gateway:
    def __init__(self, token: str) -> None:
        self.token = token
        self.client_lock = asyncio.Lock()

    async def handle(self, websocket: Any) -> None:
        path = websocket.request.path
        authorization = websocket.request.headers.get("Authorization", "")
        if not authenticated_request(path, authorization, self.token):
            log("client_rejected", reason="authentication")
            await websocket.close(code=4401, reason="Authentication required")
            return
        if self.client_lock.locked():
            await websocket.close(code=4429, reason="Mobile Yuki is already connected")
            return
        async with self.client_lock:
            log("client_connected")
            await websocket.send(json.dumps({
                "type": "mobile.realtime.authenticated",
                "sample_rate": SAMPLE_RATE,
                "input_channel": INPUT_AUDIO,
                "output_channel": OUTPUT_AUDIO,
            }))
            try:
                await MobileClient(websocket).run()
            finally:
                log("client_disconnected")


async def async_main(args: argparse.Namespace) -> None:
    token_path = Path(args.token_file).expanduser()
    token = ensure_token(token_path)
    voice_runtime.load_hermes_bridge()
    gateway = Gateway(token)
    shutdown = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, shutdown.set)
    ssl_context = None
    if bool(args.tls_cert) != bool(args.tls_key):
        raise RuntimeError("Both --tls-cert and --tls-key are required for TLS")
    if args.tls_cert and args.tls_key:
        import ssl
        ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_context.load_cert_chain(args.tls_cert, args.tls_key)
    async with websockets.serve(
        gateway.handle,
        args.host,
        args.port,
        ssl=ssl_context,
        max_size=MAX_AUDIO_MESSAGE + 1024,
        compression=None,
        ping_interval=20,
        ping_timeout=20,
    ):
        log(
            "gateway_ready",
            host=args.host,
            port=args.port,
            tls=bool(ssl_context),
            token_file=str(token_path),
            token_fingerprint=token_fingerprint(token),
            hermy_tools=voice_runtime.ask_hermes is not None,
        )
        await shutdown.wait()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8789)
    parser.add_argument("--token-file", default=str(DEFAULT_TOKEN_FILE))
    parser.add_argument("--tls-cert")
    parser.add_argument("--tls-key")
    return parser.parse_args()


def main() -> int:
    asyncio.run(async_main(parse_args()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
