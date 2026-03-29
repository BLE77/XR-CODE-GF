from __future__ import annotations

import json
import subprocess
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from xr_agent.hermes_adapter import HermesAdapter


_CLIENT_CAPABILITIES = {
    "fs": {"readTextFile": True, "writeTextFile": True},
    "terminal": True,
}


@dataclass
class HermesPromptResult:
    reply_text: str
    session_id: str | None
    transport: str
    thoughts: list[str] = field(default_factory=list)


class _PendingRPC:
    def __init__(self) -> None:
        self.event = threading.Event()
        self.message: dict[str, Any] | None = None


@dataclass
class _ActivePrompt:
    session_id: str
    request_id: int
    reply_chunks: list[str] = field(default_factory=list)
    thought_chunks: list[str] = field(default_factory=list)


class PersistentHermesRuntime:
    def __init__(
        self,
        *,
        adapter: HermesAdapter,
        startup_timeout: float = 10.0,
        session_timeout: float = 45.0,
        prompt_timeout: float = 300.0,
    ) -> None:
        self.adapter = adapter
        self.startup_timeout = startup_timeout
        self.session_timeout = session_timeout
        self.prompt_timeout = prompt_timeout

        self._lock = threading.RLock()
        self._prompt_lock = threading.Lock()
        self._next_request_id = 1
        self._pending: dict[int, _PendingRPC] = {}
        self._process: subprocess.Popen[str] | None = None
        self._stdout_thread: threading.Thread | None = None
        self._stderr_thread: threading.Thread | None = None
        self._sessions_by_repo: dict[str, str] = {}
        self._active_prompt: _ActivePrompt | None = None
        self._transport_mode: str | None = None
        self._stderr_tail: deque[str] = deque(maxlen=80)
        self._last_reply: str | None = None

    @property
    def last_reply(self) -> str | None:
        return self._last_reply

    def start(self) -> None:
        with self._lock:
            if self._transport_mode is not None:
                return

        if Path(self.adapter.hermes_cmd).name != "hermes":
            with self._lock:
                self._transport_mode = "cli"
            return

        try:
            self._start_acp()
        except Exception:
            self.stop()
            with self._lock:
                self._transport_mode = "cli"

    def stop(self) -> None:
        with self._lock:
            process = self._process
            self._process = None
            self._transport_mode = None
            self._sessions_by_repo.clear()
            self._active_prompt = None
            pending = list(self._pending.values())
            self._pending.clear()

        for waiter in pending:
            waiter.message = {
                "error": {"message": "Hermes runtime stopped before the request completed."}
            }
            waiter.event.set()

        if process is None:
            return

        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)

    def warm_session(self, repo_path: str | Path) -> None:
        thread = threading.Thread(
            target=self._warm_session_worker,
            args=(str(Path(repo_path).expanduser().resolve()),),
            daemon=True,
            name="persistent-hermes-warmup",
        )
        thread.start()

    def prompt(self, repo_path: str | Path, prompt: str) -> HermesPromptResult:
        repo_root = str(Path(repo_path).expanduser().resolve())
        self.start()
        transport_mode = self._transport_mode or "cli"

        if transport_mode == "acp":
            try:
                result = self._prompt_via_acp(repo_root, prompt)
                self._last_reply = result.reply_text
                return result
            except Exception:
                self.stop()
                with self._lock:
                    self._transport_mode = "cli"

        result = self._prompt_via_cli(repo_root, prompt)
        self._last_reply = result.reply_text
        return result

    def _warm_session_worker(self, repo_path: str) -> None:
        try:
            self.start()
            if self._transport_mode == "acp":
                self._ensure_session(repo_path)
        except Exception:
            return

    def _start_acp(self) -> None:
        process = subprocess.Popen(
            [self.adapter.hermes_cmd, "acp"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        if process.stdin is None or process.stdout is None or process.stderr is None:
            raise RuntimeError("Hermes ACP failed to expose stdio streams.")

        self._process = process
        self._stdout_thread = threading.Thread(
            target=self._stdout_reader,
            args=(process.stdout,),
            daemon=True,
            name="persistent-hermes-stdout",
        )
        self._stderr_thread = threading.Thread(
            target=self._stderr_reader,
            args=(process.stderr,),
            daemon=True,
            name="persistent-hermes-stderr",
        )
        self._stdout_thread.start()
        self._stderr_thread.start()

        initialize = self._request(
            "initialize",
            {
                "protocolVersion": 1,
                "clientCapabilities": _CLIENT_CAPABILITIES,
                "clientInfo": {"name": "xr-coding-agent", "version": "0.1.0"},
            },
            timeout=self.startup_timeout,
        )
        result = initialize.get("result", {})
        auth_methods = result.get("authMethods") or []
        if auth_methods:
            method_id = auth_methods[0].get("id")
            if isinstance(method_id, str) and method_id:
                self._request(
                    "authenticate",
                    {"methodId": method_id},
                    timeout=self.startup_timeout,
                )

        with self._lock:
            self._transport_mode = "acp"

    def _stdout_reader(self, stream: Any) -> None:
        for raw_line in stream:
            stripped = raw_line.strip()
            if not stripped:
                continue
            try:
                message = json.loads(stripped)
            except json.JSONDecodeError:
                continue
            self._handle_message(message)

    def _stderr_reader(self, stream: Any) -> None:
        for raw_line in stream:
            stripped = raw_line.rstrip("\n")
            if not stripped:
                continue
            with self._lock:
                self._stderr_tail.append(stripped)

    def _handle_message(self, message: dict[str, Any]) -> None:
        if "method" in message:
            self._handle_notification(message)
            return

        request_id = message.get("id")
        if not isinstance(request_id, int):
            return

        with self._lock:
            waiter = self._pending.get(request_id)
        if waiter is None:
            return
        waiter.message = message
        waiter.event.set()

    def _handle_notification(self, message: dict[str, Any]) -> None:
        if message.get("method") != "session/update":
            return

        params = message.get("params")
        if not isinstance(params, dict):
            return

        session_id = params.get("sessionId")
        update = params.get("update")
        if not isinstance(session_id, str) or not isinstance(update, dict):
            return

        update_type = update.get("sessionUpdate")
        content = update.get("content")
        text = None
        if isinstance(content, dict):
            candidate = content.get("text")
            if isinstance(candidate, str):
                text = candidate

        with self._lock:
            active = self._active_prompt

        if active is None or active.session_id != session_id or text is None:
            return

        if update_type == "agent_message_chunk":
            active.reply_chunks.append(text)
        elif update_type == "agent_thought_chunk":
            active.thought_chunks.append(text)

    def _request(self, method: str, params: dict[str, Any], *, timeout: float) -> dict[str, Any]:
        request_id = self._reserve_request()
        waiter = _PendingRPC()
        with self._lock:
            self._pending[request_id] = waiter
            process = self._process

        if process is None or process.stdin is None:
            raise RuntimeError("Hermes ACP process is not running.")

        payload = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        }
        process.stdin.write(json.dumps(payload) + "\n")
        process.stdin.flush()

        if not waiter.event.wait(timeout):
            with self._lock:
                self._pending.pop(request_id, None)
            raise TimeoutError(f"Hermes ACP request '{method}' timed out.")

        with self._lock:
            self._pending.pop(request_id, None)

        message = waiter.message or {}
        if "error" in message:
            error = message["error"]
            if isinstance(error, dict):
                detail = error.get("message") or error.get("data") or "Unknown ACP error."
            else:
                detail = str(error)
            raise RuntimeError(f"Hermes ACP request '{method}' failed: {detail}")
        return message

    def _reserve_request(self) -> int:
        with self._lock:
            request_id = self._next_request_id
            self._next_request_id += 1
        return request_id

    def _ensure_session(self, repo_path: str) -> str:
        with self._lock:
            existing = self._sessions_by_repo.get(repo_path)
        if existing is not None:
            return existing

        response = self._request(
            "session/new",
            {"cwd": repo_path, "mcpServers": []},
            timeout=self.session_timeout,
        )
        session_id = response.get("result", {}).get("sessionId")
        if not isinstance(session_id, str) or not session_id:
            raise RuntimeError("Hermes ACP did not return a session ID.")
        with self._lock:
            self._sessions_by_repo[repo_path] = session_id
        return session_id

    def _prompt_via_acp(self, repo_path: str, prompt: str) -> HermesPromptResult:
        session_id = self._ensure_session(repo_path)
        with self._prompt_lock:
            request_id = self._next_request_id
            active_prompt = _ActivePrompt(session_id=session_id, request_id=request_id)
            with self._lock:
                self._active_prompt = active_prompt
            try:
                self._request(
                    "session/prompt",
                    {
                        "sessionId": session_id,
                        "prompt": [{"type": "text", "text": prompt}],
                    },
                    timeout=self.prompt_timeout,
                )
            finally:
                with self._lock:
                    self._active_prompt = None

        reply_text = _merge_chunks(active_prompt.reply_chunks)
        if not reply_text:
            raise RuntimeError("Hermes returned no assistant message over ACP.")
        return HermesPromptResult(
            reply_text=reply_text,
            session_id=session_id,
            transport="acp",
            thoughts=list(active_prompt.thought_chunks),
        )

    def _prompt_via_cli(self, repo_path: str, prompt: str) -> HermesPromptResult:
        completed = subprocess.run(
            self.adapter.build_cli_command(prompt),
            cwd=Path(repo_path),
            capture_output=True,
            text=True,
            check=False,
        )
        combined = "\n".join(part for part in [completed.stdout, completed.stderr] if part)
        reply_text = self.adapter.extract_assistant_reply(combined)
        if not reply_text:
            reply_text = (combined or f"Hermes exited with code {completed.returncode}.").strip()
        return HermesPromptResult(
            reply_text=reply_text,
            session_id=None,
            transport="cli",
        )


def _merge_chunks(chunks: list[str]) -> str:
    if not chunks:
        return ""
    joined = "".join(chunks).strip()
    if joined:
        return joined
    return "\n\n".join(chunk.strip() for chunk in chunks if chunk.strip()).strip()
