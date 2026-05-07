from __future__ import annotations

import codecs
import fcntl
import os
import pty
import re
import shutil
import signal
import struct
import subprocess
import threading
import time
import termios
import uuid
from collections.abc import Iterable
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path
from typing import Callable, Sequence

from xr_agent.models import SessionStatus

CodingSessionCallback = Callable[["ManagedCodingSession"], None]
CodingSessionOutputCallback = Callable[["ManagedCodingSession", str], None]
CodingSessionScreenCallback = Callable[["ManagedCodingSession"], None]
CodingSessionNoticeCallback = Callable[["ManagedCodingSession", str], None]

_ANSI_ESCAPE_PATTERN = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
_WHITESPACE_PATTERN = re.compile(r"\s+")


@dataclass(frozen=True)
class CodingSessionTool:
    intent: str
    title: str
    argv: tuple[str, ...]

    @property
    def executable(self) -> str:
        return self.argv[0]

    @property
    def launch_command(self) -> str:
        return " ".join(self.argv)


@dataclass
class ManagedCodingSession:
    session_id: str
    intent: str
    title: str
    repo_path: str
    command: str
    status: SessionStatus
    started_at: datetime
    finished_at: datetime | None = None
    exit_code: int | None = None
    pid: int | None = None
    output_tail: list[str] | None = None
    summary: str | None = None
    auto_accept_trust_dialog: bool = False
    log_path: str | None = None
    screen_text: str | None = None
    screen_rows: int | None = None
    screen_columns: int | None = None


DEFAULT_CODING_SESSION_TOOLS: dict[str, CodingSessionTool] = {
    "open_codex": CodingSessionTool(
        intent="open_codex",
        title="Codex CLI",
        argv=("codex",),
    ),
    "open_claude_code": CodingSessionTool(
        intent="open_claude_code",
        title="Claude Code",
        argv=("claude",),
    ),
    "open_hermes_cli": CodingSessionTool(
        intent="open_hermes_cli",
        title="Hermes CLI",
        argv=("hermes",),
    ),
    "open_kimi_code": CodingSessionTool(
        intent="open_kimi_code",
        title="Kimi Code",
        argv=("kimi",),
    ),
}


class ManagedCodingSessionManager:
    def __init__(
        self,
        *,
        tools: dict[str, CodingSessionTool] | None = None,
        max_output_tail_lines: int = 120,
        log_dir: str | Path | None = None,
        auto_open_debug_log_terminal: bool = False,
        screen_rows: int = 48,
        screen_columns: int = 160,
    ) -> None:
        self.tools = dict(tools or DEFAULT_CODING_SESSION_TOOLS)
        self.max_output_tail_lines = max_output_tail_lines
        self.log_dir = Path(log_dir).expanduser().resolve() if log_dir is not None else None
        self.auto_open_debug_log_terminal = auto_open_debug_log_terminal
        self.screen_rows = max(8, screen_rows)
        self.screen_columns = max(40, screen_columns)
        if self.log_dir is not None:
            self.log_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._sessions: dict[str, ManagedCodingSession] = {}
        self._start_order: list[str] = []
        self._masters: dict[str, int] = {}
        self._processes: dict[str, subprocess.Popen[bytes]] = {}
        self._screens: dict[str, "_AnsiScreenBuffer"] = {}
        self._threads: dict[str, threading.Thread] = {}
        self._auto_confirmed_prompts: set[str] = set()

    def start_session(
        self,
        intent: str,
        repo_path: str | Path,
        *,
        extra_args: Sequence[str] | None = None,
        auto_accept_trust_dialog: bool = False,
        on_started: CodingSessionCallback | None = None,
        on_output: CodingSessionOutputCallback | None = None,
        on_screen: CodingSessionScreenCallback | None = None,
        on_notice: CodingSessionNoticeCallback | None = None,
        on_finished: CodingSessionCallback | None = None,
    ) -> ManagedCodingSession:
        tool = self._resolve_tool(intent)
        repo_root = Path(repo_path).expanduser().resolve()
        executable_path = shutil.which(tool.executable)
        if executable_path is None:
            raise FileNotFoundError(f"{tool.executable} is not installed or not on PATH")

        launch_argv = [executable_path, *tool.argv[1:], *(extra_args or ())]
        session_id = f"term_{uuid.uuid4().hex[:8]}"
        session = ManagedCodingSession(
            session_id=session_id,
            intent=intent,
            title=tool.title,
            repo_path=str(repo_root),
            command=" ".join([tool.executable, *tool.argv[1:], *(extra_args or ())]),
            status=SessionStatus.STARTING,
            started_at=datetime.now(),
            output_tail=[],
            auto_accept_trust_dialog=auto_accept_trust_dialog,
            log_path=self._session_log_path_for_id(session_id),
            screen_text="",
            screen_rows=self.screen_rows,
            screen_columns=self.screen_columns,
        )
        with self._lock:
            self._sessions[session.session_id] = session
            self._start_order.append(session.session_id)
            self._screens[session.session_id] = _AnsiScreenBuffer(
                rows=self.screen_rows,
                columns=self.screen_columns,
            )
        self._write_log_header(session)

        master_fd, slave_fd = pty.openpty()
        env = os.environ.copy()
        if not env.get("TERM") or env.get("TERM") == "dumb":
            env["TERM"] = "xterm-256color"
        env.setdefault("COLORTERM", "truecolor")
        _set_pty_window_size(slave_fd, rows=self.screen_rows, columns=self.screen_columns)

        try:
            process = subprocess.Popen(
                launch_argv,
                cwd=repo_root,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                env=env,
                close_fds=True,
                start_new_session=True,
            )
        except Exception:
            os.close(master_fd)
            os.close(slave_fd)
            raise
        finally:
            try:
                os.close(slave_fd)
            except OSError:
                pass

        running = replace(session, status=SessionStatus.RUNNING, pid=process.pid)
        with self._lock:
            self._sessions[session.session_id] = running
            self._masters[session.session_id] = master_fd
            self._processes[session.session_id] = process

        if on_started is not None:
            on_started(running)

        thread = threading.Thread(
            target=self._read_session_output,
            args=(running.session_id, process, master_fd),
            kwargs={
                "on_output": on_output,
                "on_screen": on_screen,
                "on_notice": on_notice,
                "on_finished": on_finished,
            },
            daemon=True,
            name=f"managed-coding-session-{running.session_id}",
        )
        with self._lock:
            self._threads[running.session_id] = thread
        thread.start()
        if self.auto_open_debug_log_terminal:
            try:
                self.open_session_log_in_terminal(running.session_id)
            except Exception:
                # Debug mirrors should never block the actual managed session.
                pass
        return running

    def send_input(self, session_id: str, text: str) -> ManagedCodingSession:
        clean_text = text.rstrip("\r\n")
        if not clean_text:
            raise ValueError("Cannot send an empty message to a coding session")

        with self._lock:
            session = self._sessions.get(session_id)
            master_fd = self._masters.get(session_id)
        if session is None or master_fd is None:
            raise KeyError(f"No managed coding session found for {session_id}")
        if session.status not in {SessionStatus.STARTING, SessionStatus.RUNNING}:
            raise RuntimeError(f"{session.title} is no longer running")

        # PTY-backed CLIs expect an Enter keypress (`\r`), not a pasted newline.
        # Using `\n` leaves Claude sitting in its composer instead of submitting.
        payload = clean_text.replace("\r\n", "\r").replace("\n", "\r") + "\r"
        os.write(master_fd, payload.encode("utf-8"))
        return session

    def wait_until_ready_for_input(
        self,
        session_id: str,
        *,
        timeout: float = 5.0,
        stable_for: float = 0.2,
    ) -> ManagedCodingSession:
        deadline = time.monotonic() + max(0.0, timeout)
        last_text = ""
        last_changed_at = time.monotonic()

        while True:
            session = self._require_session(session_id)
            if session.status not in {SessionStatus.STARTING, SessionStatus.RUNNING}:
                return session

            visible_text = session.screen_text or "\n".join(session.output_tail or [])
            normalized_text = _normalized_prompt_text(visible_text)
            compact_text = _compact_prompt_text(normalized_text)
            prompt_pending = self._auto_accept_prompt_pending(session, normalized_text, compact_text)
            now = time.monotonic()

            if normalized_text and not prompt_pending:
                if normalized_text != last_text:
                    last_text = normalized_text
                    last_changed_at = now
                elif now - last_changed_at >= stable_for:
                    return session

            if now >= deadline:
                return session
            time.sleep(0.05)

    def open_session_log_in_terminal(self, session_id: str) -> ManagedCodingSession:
        session = self._require_session(session_id)
        log_path = self._require_log_path(session)
        tail_command = f"clear; echo 'Tailing {session.title}'; echo '{log_path}'; echo; tail -n 200 -f {self._shell_quote(log_path)}"
        subprocess.run(
            [
                "osascript",
                "-e",
                'tell application "Terminal"',
                "-e",
                "activate",
                "-e",
                f'do script "{self._applescript_escape(tail_command)}"',
                "-e",
                "end tell",
            ],
            check=True,
        )
        return session

    def reveal_session_log(self, session_id: str) -> ManagedCodingSession:
        session = self._require_session(session_id)
        log_path = self._require_log_path(session)
        subprocess.run(["open", "-R", log_path], check=True)
        return session

    def close_session(self, session_id: str, timeout: float = 1.0) -> ManagedCodingSession:
        with self._lock:
            session = self._sessions.get(session_id)
            process = self._processes.get(session_id)
            master_fd = self._masters.get(session_id)
        if session is None or process is None:
            raise KeyError(f"No managed coding session found for {session_id}")

        self._terminate_process_group(process, timeout=timeout)

        if master_fd is not None:
            try:
                os.close(master_fd)
            except OSError:
                pass

        with self._lock:
            self._masters.pop(session_id, None)
            self._processes.pop(session_id, None)
        return self.get(session_id) or session

    def latest_session(self, *, intent: str | None = None) -> ManagedCodingSession | None:
        with self._lock:
            for session_id in reversed(self._start_order):
                session = self._sessions.get(session_id)
                if session is None:
                    continue
                if intent is not None and session.intent != intent:
                    continue
                return session
        return None

    def get(self, session_id: str) -> ManagedCodingSession | None:
        with self._lock:
            return self._sessions.get(session_id)

    def list_sessions(self) -> list[ManagedCodingSession]:
        with self._lock:
            sessions = [self._sessions[session_id] for session_id in self._start_order if session_id in self._sessions]
        return list(reversed(sessions))

    def summarize_open_sessions(self) -> str:
        sessions = [
            session
            for session in self.list_sessions()
            if session.status in {SessionStatus.STARTING, SessionStatus.RUNNING}
        ]
        if not sessions:
            return "No managed Codex, Claude Code, or Hermes sessions are open right now."

        lines = []
        for session in sessions[:6]:
            last_line = session.output_tail[-1] if session.output_tail else "waiting for output"
            lines.append(f"{session.title} in {session.repo_path}: {last_line}")
        return "Managed coding sessions: " + "; ".join(lines)

    def shutdown(self, timeout: float = 1.0) -> None:
        with self._lock:
            processes = list(self._processes.items())
        for session_id, process in processes:
            self._terminate_process_group(process, timeout=timeout)
        for session_id, process in processes:
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                except OSError:
                    process.kill()
                try:
                    process.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    process.kill()
        with self._lock:
            for master_fd in self._masters.values():
                try:
                    os.close(master_fd)
                except OSError:
                    pass
            self._masters.clear()
            self._screens.clear()
            self._auto_confirmed_prompts.clear()

    def _resolve_tool(self, intent: str) -> CodingSessionTool:
        try:
            return self.tools[intent]
        except KeyError as exc:
            raise KeyError(f"Unsupported coding session intent: {intent}") from exc

    def _terminate_process_group(self, process: subprocess.Popen[bytes], timeout: float) -> None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        except OSError:
            process.terminate()

        try:
            process.wait(timeout=timeout)
            return
        except subprocess.TimeoutExpired:
            pass

        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            return
        except OSError:
            process.kill()

        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()

    def _append_output(self, session_id: str, text: str) -> ManagedCodingSession:
        fragments = [fragment for fragment in _normalize_output_fragments(text) if fragment]
        self._append_log_text(session_id, text)

        with self._lock:
            screen = self._screens.get(session_id)
        screen_text = None
        if screen is not None:
            screen.feed(text)
            screen_text = screen.render_text()

        with self._lock:
            session = self._sessions[session_id]
            updated_tail = list(session.output_tail or [])
            updated_tail.extend(fragments)
            if len(updated_tail) > self.max_output_tail_lines:
                updated_tail = updated_tail[-self.max_output_tail_lines :]
            updated = replace(
                session,
                output_tail=updated_tail,
                screen_text=screen_text if screen_text is not None else session.screen_text,
                screen_rows=self.screen_rows,
                screen_columns=self.screen_columns,
            )
            self._sessions[session_id] = updated
        return updated

    def _mark_finished(self, session_id: str, exit_code: int) -> ManagedCodingSession:
        status = SessionStatus.FINISHED if exit_code == 0 else SessionStatus.FAILED
        with self._lock:
            session = self._sessions[session_id]
            updated = replace(
                session,
                status=status,
                exit_code=exit_code,
                finished_at=datetime.now(),
                summary=f"{session.title} exited with code {exit_code}.",
            )
            self._sessions[session_id] = updated
            master_fd = self._masters.pop(session_id, None)
            self._processes.pop(session_id, None)
            self._screens.pop(session_id, None)
            self._auto_confirmed_prompts = {
                marker for marker in self._auto_confirmed_prompts if not marker.startswith(f"{session_id}:")
            }
        if master_fd is not None:
            try:
                os.close(master_fd)
            except OSError:
                pass
        self._append_log_lines(
            session_id,
            [
                "",
                f"[session finished] status={status.value} exit_code={exit_code} at {updated.finished_at.isoformat() if updated.finished_at else 'unknown'}",
            ],
        )
        return updated

    def _read_session_output(
        self,
        session_id: str,
        process: subprocess.Popen[bytes],
        master_fd: int,
        *,
        on_output: CodingSessionOutputCallback | None,
        on_screen: CodingSessionScreenCallback | None,
        on_notice: CodingSessionNoticeCallback | None,
        on_finished: CodingSessionCallback | None,
    ) -> None:
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        try:
            while True:
                try:
                    raw_chunk = os.read(master_fd, 4096)
                except OSError:
                    break

                if not raw_chunk:
                    if process.poll() is not None:
                        break
                    time.sleep(0.05)
                    continue

                text = decoder.decode(raw_chunk)
                updated = self._append_output(session_id, text)
                self._maybe_auto_accept_trust_prompt(updated, master_fd, on_notice=on_notice)
                if on_screen is not None:
                    on_screen(updated)
                if on_output is not None:
                    for fragment in _normalize_output_fragments(text):
                        if fragment:
                            on_output(updated, fragment)
        finally:
            remainder = decoder.decode(b"", final=True)
            if remainder:
                updated = self._append_output(session_id, remainder)
                self._maybe_auto_accept_trust_prompt(updated, master_fd, on_notice=on_notice)
                if on_screen is not None:
                    on_screen(updated)
                if on_output is not None:
                    for fragment in _normalize_output_fragments(remainder):
                        if fragment:
                            on_output(updated, fragment)

            exit_code = process.wait()
            finished = self._mark_finished(session_id, exit_code)
            if on_finished is not None:
                on_finished(finished)

    def _maybe_auto_accept_trust_prompt(
        self,
        session: ManagedCodingSession,
        master_fd: int,
        *,
        on_notice: CodingSessionNoticeCallback | None = None,
    ) -> None:
        if not session.auto_accept_trust_dialog:
            return

        prompt_text = _normalized_prompt_text(
            "\n".join(
                part
                for part in (
                    session.screen_text or "",
                    "\n".join(session.output_tail or []),
                )
                if part
            )
        )
        compact_prompt_text = _compact_prompt_text(prompt_text)
        confirmation_bytes: bytes | None = None
        log_line: str | None = None
        notice_text: str | None = None
        prompt_key: str | None = None
        trust_prompt_visible = _claude_trust_prompt_visible(prompt_text)
        bypass_prompt_visible = _claude_bypass_prompt_visible(compact_prompt_text)
        mcp_server_prompt_visible = _claude_mcp_server_prompt_visible(prompt_text, compact_prompt_text)

        if bypass_prompt_visible and f"{session.session_id}:bypass-permissions" not in self._auto_confirmed_prompts:
            # Current Claude CLI warning defaults to "No, exit", so we move to
            # the accept option before confirming.
            prompt_key = "bypass-permissions"
            confirmation_bytes = b"\x1b[B\r"
            log_line = "[auto-accepted claude bypass-permissions prompt]"
            notice_text = "Hermes approved Claude's bypass-permissions prompt and Claude is continuing."
        elif mcp_server_prompt_visible and f"{session.session_id}:mcp-server" not in self._auto_confirmed_prompts:
            prompt_key = "mcp-server"
            confirmation_bytes = b"\r"
            log_line = "[auto-accepted claude mcp server prompt]"
            notice_text = "Hermes approved Claude's MCP server prompt and Claude is continuing."
        elif trust_prompt_visible and f"{session.session_id}:trust" not in self._auto_confirmed_prompts:
            prompt_key = "trust"
            confirmation_bytes = b"\r"
            log_line = "[auto-accepted claude trust prompt]"
            notice_text = "Hermes approved Claude's trust prompt and Claude is continuing."

        if confirmation_bytes is None or prompt_key is None:
            return

        try:
            os.write(master_fd, confirmation_bytes)
            self._auto_confirmed_prompts.add(f"{session.session_id}:{prompt_key}")
            if log_line is not None:
                self._append_log_lines(session.session_id, [log_line])
            if on_notice is not None and notice_text is not None:
                on_notice(session, notice_text)
        except OSError:
            return

    def _auto_accept_prompt_pending(self, session: ManagedCodingSession, prompt_text: str, compact_prompt_text: str) -> bool:
        trust_pending = (
            _claude_trust_prompt_visible(prompt_text)
            and f"{session.session_id}:trust" not in self._auto_confirmed_prompts
        )
        bypass_pending = (
            _claude_bypass_prompt_visible(compact_prompt_text)
            and f"{session.session_id}:bypass-permissions" not in self._auto_confirmed_prompts
        )
        mcp_server_pending = (
            _claude_mcp_server_prompt_visible(prompt_text, compact_prompt_text)
            and f"{session.session_id}:mcp-server" not in self._auto_confirmed_prompts
        )
        return trust_pending or bypass_pending or mcp_server_pending

    def _require_session(self, session_id: str) -> ManagedCodingSession:
        session = self.get(session_id)
        if session is None:
            raise KeyError(f"No managed coding session found for {session_id}")
        return session

    def _require_log_path(self, session: ManagedCodingSession) -> str:
        if not session.log_path:
            raise RuntimeError(f"{session.title} does not have a log file yet")
        return session.log_path

    def _session_log_path_for_id(self, session_id: str) -> str | None:
        if self.log_dir is None:
            return None
        return str((self.log_dir / f"{session_id}.log").resolve())

    def _write_log_header(self, session: ManagedCodingSession) -> None:
        if not session.log_path:
            return
        lines = [
            f"[session started] {session.title}",
            f"repo={session.repo_path}",
            f"command={session.command}",
            f"started_at={session.started_at.isoformat()}",
            "",
        ]
        self._append_log_lines(session.session_id, lines)

    def _append_log_text(self, session_id: str, text: str) -> None:
        session = self.get(session_id)
        if session is None or not session.log_path:
            return
        with Path(session.log_path).open("a", encoding="utf-8") as handle:
            handle.write(text)

    def _append_log_lines(self, session_id: str, lines: Iterable[str]) -> None:
        session = self.get(session_id)
        if session is None or not session.log_path:
            return
        with Path(session.log_path).open("a", encoding="utf-8") as handle:
            for line in lines:
                handle.write(f"{line}\n")

    def _shell_quote(self, value: str) -> str:
        return "'" + value.replace("'", "'\"'\"'") + "'"

    def _applescript_escape(self, value: str) -> str:
        return value.replace("\\", "\\\\").replace('"', '\\"')


def _normalize_output_fragments(text: str) -> list[str]:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    fragments = []
    for raw_line in normalized.split("\n"):
        cleaned = _ANSI_ESCAPE_PATTERN.sub("", raw_line).strip()
        if cleaned:
            fragments.append(cleaned)
    return fragments


def _normalized_prompt_text(text: str) -> str:
    cleaned = _ANSI_ESCAPE_PATTERN.sub("", text)
    cleaned = cleaned.replace("\x00", " ")
    cleaned = cleaned.replace("\r", "\n")
    cleaned = _WHITESPACE_PATTERN.sub(" ", cleaned)
    return cleaned.strip().lower()


def _compact_prompt_text(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def _claude_trust_prompt_visible(prompt_text: str) -> bool:
    return (
        "quick safety check" in prompt_text
        and "yes, i trust this folder" in prompt_text
        and "enter to confirm" in prompt_text
    )


def _claude_bypass_prompt_visible(compact_prompt_text: str) -> bool:
    return (
        "bypasspermissionsmode" in compact_prompt_text
        and "yesiaccept" in compact_prompt_text
        and "entertoconfirm" in compact_prompt_text
    )


def _claude_mcp_server_prompt_visible(prompt_text: str, compact_prompt_text: str) -> bool:
    return (
        ("new mcp server found" in prompt_text or "mcp servers may execute code" in prompt_text)
        and (
            "use this and all future mcp servers in this project" in prompt_text
            or "usethisandallfuturemcpserversinthisproject" in compact_prompt_text
        )
        and ("enter to confirm" in prompt_text or "entertoconfirm" in compact_prompt_text)
    )


def _parse_csi_numbers(values: str) -> list[int]:
    if not values:
        return []

    numbers: list[int] = []
    for value in values.split(";"):
        if not value:
            numbers.append(0)
            continue
        match = re.search(r"\d+", value)
        if match is None:
            return []
        numbers.append(int(match.group(0)))
    return numbers


def _set_pty_window_size(fd: int, *, rows: int, columns: int) -> None:
    packed = struct.pack("HHHH", rows, columns, 0, 0)
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)
    except OSError:
        return


class _AnsiScreenBuffer:
    def __init__(self, *, rows: int, columns: int) -> None:
        self.rows = rows
        self.columns = columns
        self.cursor_row = 0
        self.cursor_column = 0
        self._saved_cursor = (0, 0)
        self._lines = [list(" " * columns) for _ in range(rows)]
        self._alternate_state: tuple[list[list[str]], tuple[int, int]] | None = None
        self._state = "normal"
        self._csi_buffer = ""

    def feed(self, text: str) -> None:
        index = 0
        while index < len(text):
            char = text[index]

            if self._state == "osc":
                if char == "\a":
                    self._state = "normal"
                elif char == "\x1b" and index + 1 < len(text) and text[index + 1] == "\\":
                    self._state = "normal"
                    index += 1
                index += 1
                continue

            if self._state == "csi":
                if "\x40" <= char <= "\x7e":
                    self._handle_csi(self._csi_buffer, char)
                    self._csi_buffer = ""
                    self._state = "normal"
                else:
                    self._csi_buffer += char
                index += 1
                continue

            if self._state == "escape":
                if char == "[":
                    self._state = "csi"
                    self._csi_buffer = ""
                elif char == "]":
                    self._state = "osc"
                elif char == "7":
                    self._saved_cursor = (self.cursor_row, self.cursor_column)
                    self._state = "normal"
                elif char == "8":
                    self.cursor_row, self.cursor_column = self._saved_cursor
                    self._state = "normal"
                else:
                    self._state = "normal"
                index += 1
                continue

            if char == "\x1b":
                self._state = "escape"
            elif char == "\n":
                self._newline()
            elif char == "\r":
                self.cursor_column = 0
            elif char == "\b":
                self.cursor_column = max(0, self.cursor_column - 1)
            elif char == "\t":
                spaces = 8 - (self.cursor_column % 8)
                for _ in range(spaces):
                    self._put_char(" ")
            elif char >= " ":
                self._put_char(char)
            index += 1

    def render_text(self) -> str:
        rendered_lines = ["".join(line).rstrip() for line in self._lines]
        while rendered_lines and not rendered_lines[-1]:
            rendered_lines.pop()
        return "\n".join(rendered_lines)

    def _handle_csi(self, params: str, final: str) -> None:
        private = ""
        values = params
        if values[:1] in {"?", ">", "=", "!"}:
            private = values[0]
            values = values[1:]

        if final == "m":
            return
        if final in {"s", "u"}:
            if final == "s":
                self._saved_cursor = (self.cursor_row, self.cursor_column)
            else:
                self.cursor_row, self.cursor_column = self._saved_cursor
            return
        if final in {"h", "l"} and private == "?":
            self._handle_private_mode(values, final)
            return
        if private:
            return

        numbers = _parse_csi_numbers(values)

        if final == "A":
            self.cursor_row = max(0, self.cursor_row - self._param(numbers, 0, default=1))
        elif final == "B":
            self.cursor_row = min(self.rows - 1, self.cursor_row + self._param(numbers, 0, default=1))
        elif final == "C":
            self.cursor_column = min(self.columns - 1, self.cursor_column + self._param(numbers, 0, default=1))
        elif final == "D":
            self.cursor_column = max(0, self.cursor_column - self._param(numbers, 0, default=1))
        elif final == "E":
            self.cursor_row = min(self.rows - 1, self.cursor_row + self._param(numbers, 0, default=1))
            self.cursor_column = 0
        elif final == "F":
            self.cursor_row = max(0, self.cursor_row - self._param(numbers, 0, default=1))
            self.cursor_column = 0
        elif final == "G":
            self.cursor_column = self._clamp_column(self._param(numbers, 0, default=1) - 1)
        elif final in {"H", "f"}:
            row = self._param(numbers, 0, default=1) - 1
            column = self._param(numbers, 1, default=1) - 1
            self.cursor_row = self._clamp_row(row)
            self.cursor_column = self._clamp_column(column)
        elif final == "J":
            self._erase_display(self._param(numbers, 0, default=0))
        elif final == "K":
            self._erase_line(self._param(numbers, 0, default=0))
        elif final == "P":
            self._delete_characters(self._param(numbers, 0, default=1))
        elif final == "@":
            self._insert_characters(self._param(numbers, 0, default=1))

    def _handle_private_mode(self, values: str, final: str) -> None:
        if values not in {"47", "1047", "1049"}:
            return
        if final == "h":
            saved_lines = [line[:] for line in self._lines]
            self._alternate_state = (saved_lines, (self.cursor_row, self.cursor_column))
            self._clear_screen()
            self.cursor_row = 0
            self.cursor_column = 0
            return
        if self._alternate_state is None:
            return
        lines, cursor = self._alternate_state
        self._lines = [line[:] for line in lines]
        self.cursor_row, self.cursor_column = cursor
        self._alternate_state = None

    def _newline(self) -> None:
        if self.cursor_row == self.rows - 1:
            self._scroll_up()
        else:
            self.cursor_row += 1
        self.cursor_column = 0

    def _put_char(self, char: str) -> None:
        if self.cursor_column >= self.columns:
            self._newline()
        self._lines[self.cursor_row][self.cursor_column] = char
        self.cursor_column += 1
        if self.cursor_column >= self.columns:
            self._newline()

    def _scroll_up(self, count: int = 1) -> None:
        for _ in range(max(1, count)):
            self._lines.pop(0)
            self._lines.append(list(" " * self.columns))

    def _clear_screen(self) -> None:
        self._lines = [list(" " * self.columns) for _ in range(self.rows)]

    def _erase_display(self, mode: int) -> None:
        if mode == 2:
            self._clear_screen()
            return
        if mode == 1:
            for row in range(0, self.cursor_row):
                self._lines[row] = list(" " * self.columns)
            for column in range(0, self.cursor_column + 1):
                self._lines[self.cursor_row][column] = " "
            return
        for column in range(self.cursor_column, self.columns):
            self._lines[self.cursor_row][column] = " "
        for row in range(self.cursor_row + 1, self.rows):
            self._lines[row] = list(" " * self.columns)

    def _erase_line(self, mode: int) -> None:
        if mode == 2:
            self._lines[self.cursor_row] = list(" " * self.columns)
            return
        if mode == 1:
            for column in range(0, self.cursor_column + 1):
                self._lines[self.cursor_row][column] = " "
            return
        for column in range(self.cursor_column, self.columns):
            self._lines[self.cursor_row][column] = " "

    def _delete_characters(self, count: int) -> None:
        count = max(1, count)
        line = self._lines[self.cursor_row]
        for _ in range(count):
            line.pop(self.cursor_column)
            line.append(" ")

    def _insert_characters(self, count: int) -> None:
        count = max(1, count)
        line = self._lines[self.cursor_row]
        for _ in range(count):
            line.insert(self.cursor_column, " ")
            line.pop()

    def _clamp_row(self, value: int) -> int:
        return max(0, min(self.rows - 1, value))

    def _clamp_column(self, value: int) -> int:
        return max(0, min(self.columns - 1, value))

    def _param(self, values: list[int], index: int, *, default: int) -> int:
        if index >= len(values):
            return default
        return values[index] or default
