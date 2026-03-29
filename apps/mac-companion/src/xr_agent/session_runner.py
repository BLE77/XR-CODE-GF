from __future__ import annotations

import subprocess
import threading
import uuid
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from typing import Callable, Sequence

from xr_agent.models import Session, SessionStatus
from xr_agent.session_store import SessionStore

SessionCallback = Callable[[Session], None]
OutputCallback = Callable[[Session, str], None]


class SessionRunner:
    def __init__(self, store: SessionStore, max_output_tail_lines: int = 50) -> None:
        self.store = store
        self.max_output_tail_lines = max_output_tail_lines
        self._threads: dict[str, threading.Thread] = {}

    def create_session(self, repo_path: str, command: str, title: str) -> Session:
        session = Session(
            session_id=f"sess_{uuid.uuid4().hex[:8]}",
            title=title,
            repo_path=repo_path,
            command=command,
            status=SessionStatus.STARTING,
            started_at=datetime.now(),
        )
        self.store.add(session)
        return session

    def mark_running(self, session_id: str, pid: int) -> Session:
        session = self.store.get(session_id)
        assert session is not None
        updated = replace(session, status=SessionStatus.RUNNING, pid=pid)
        self.store.update(updated)
        return updated

    def append_output(self, session_id: str, line: str) -> Session:
        cleaned = line.rstrip("\n")
        self.store.append_output(session_id, cleaned, self.max_output_tail_lines)
        session = self.store.get(session_id)
        assert session is not None
        return session

    def finish(self, session_id: str, exit_code: int, summary: str | None = None) -> Session:
        session = self.store.get(session_id)
        assert session is not None
        status = SessionStatus.FINISHED if exit_code == 0 else SessionStatus.FAILED
        updated = replace(
            session,
            status=status,
            exit_code=exit_code,
            finished_at=datetime.now(),
            summary=summary,
        )
        self.store.update(updated)
        return updated

    def start_command(
        self,
        repo_path: str,
        command: str,
        title: str,
        *,
        argv: Sequence[str] | None = None,
        shell: bool = True,
        on_started: SessionCallback | None = None,
        on_output: OutputCallback | None = None,
        on_finished: SessionCallback | None = None,
    ) -> Session:
        session = self.create_session(repo_path=repo_path, command=command, title=title)
        thread = threading.Thread(
            target=self._run_command,
            args=(session.session_id, repo_path, command, title),
            kwargs={
                "argv": argv,
                "shell": shell,
                "on_started": on_started,
                "on_output": on_output,
                "on_finished": on_finished,
            },
            daemon=True,
        )
        self._threads[session.session_id] = thread
        thread.start()
        return session

    def wait(self, session_id: str, timeout: float | None = None) -> Session | None:
        thread = self._threads.get(session_id)
        if thread is not None:
            thread.join(timeout=timeout)
            if thread.is_alive():
                return None
        return self.store.get(session_id)

    def _run_command(
        self,
        session_id: str,
        repo_path: str,
        command: str,
        title: str,
        *,
        argv: Sequence[str] | None,
        shell: bool,
        on_started: SessionCallback | None,
        on_output: OutputCallback | None,
        on_finished: SessionCallback | None,
    ) -> None:
        try:
            process = subprocess.Popen(
                argv if argv is not None else command,
                cwd=Path(repo_path),
                shell=shell if argv is None else False,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
        except Exception as exc:  # pragma: no cover - defensive path
            session = self.finish(session_id, exit_code=1, summary=f"Failed to start: {exc}")
            if on_finished is not None:
                on_finished(session)
            return

        running = self.mark_running(session_id, pid=process.pid)
        if on_started is not None:
            on_started(running)

        assert process.stdout is not None
        for line in process.stdout:
            updated = self.append_output(session_id, line)
            if on_output is not None:
                on_output(updated, line.rstrip("\n"))

        exit_code = process.wait()
        finished = self.finish(session_id, exit_code=exit_code)
        if on_finished is not None:
            on_finished(finished)
