from __future__ import annotations

import json
from dataclasses import asdict, replace
from datetime import datetime
from pathlib import Path
from threading import RLock

from xr_agent.models import Session, SessionStatus


class SessionStore:
    def __init__(self, state_path: Path | None = None) -> None:
        self._lock = RLock()
        self._sessions: dict[str, Session] = {}
        self._completion_order: list[str] = []
        self._state_path = state_path
        if self._state_path is not None:
            self._state_path.parent.mkdir(parents=True, exist_ok=True)
            self._load()

    def add(self, session: Session) -> None:
        with self._lock:
            self._sessions[session.session_id] = session
            self._persist()

    def get(self, session_id: str) -> Session | None:
        with self._lock:
            return self._sessions.get(session_id)

    def update(self, session: Session) -> None:
        with self._lock:
            self._sessions[session.session_id] = session
            if session.status in {SessionStatus.FINISHED, SessionStatus.FAILED}:
                if session.session_id in self._completion_order:
                    self._completion_order.remove(session.session_id)
                self._completion_order.append(session.session_id)
            self._persist()

    def append_output(self, session_id: str, line: str, max_lines: int) -> None:
        with self._lock:
            session = self._sessions[session_id]
            updated = list(session.output_tail)
            updated.append(line)
            if len(updated) > max_lines:
                updated = updated[-max_lines:]
            self._sessions[session_id] = replace(session, output_tail=updated)
            self._persist()

    def list_active(self) -> list[Session]:
        with self._lock:
            return [
                session
                for session in self._sessions.values()
                if session.status in {SessionStatus.STARTING, SessionStatus.RUNNING}
            ]

    def last_completed(self) -> Session | None:
        with self._lock:
            if not self._completion_order:
                return None
            return self._sessions.get(self._completion_order[-1])

    def completed_sessions(self) -> list[Session]:
        with self._lock:
            return [
                self._sessions[session_id]
                for session_id in reversed(self._completion_order)
                if session_id in self._sessions
            ]

    def all_sessions(self) -> list[Session]:
        with self._lock:
            return list(self._sessions.values())

    def _load(self) -> None:
        if self._state_path is None or not self._state_path.exists():
            return

        payload = json.loads(self._state_path.read_text(encoding="utf-8"))
        for raw_session in payload.get("sessions", []):
            session = self._session_from_dict(raw_session)
            self._sessions[session.session_id] = session
        self._completion_order = list(payload.get("completion_order", []))

    def _persist(self) -> None:
        if self._state_path is None:
            return

        payload = {
            "sessions": [self._session_to_dict(session) for session in self._sessions.values()],
            "completion_order": self._completion_order,
        }
        self._state_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def _session_to_dict(self, session: Session) -> dict:
        payload = asdict(session)
        payload["status"] = session.status.value
        payload["started_at"] = session.started_at.isoformat()
        payload["finished_at"] = session.finished_at.isoformat() if session.finished_at else None
        return payload

    def _session_from_dict(self, payload: dict) -> Session:
        return Session(
            session_id=payload["session_id"],
            title=payload["title"],
            repo_path=payload["repo_path"],
            command=payload["command"],
            status=SessionStatus(payload["status"]),
            started_at=datetime.fromisoformat(payload["started_at"]),
            finished_at=(
                datetime.fromisoformat(payload["finished_at"])
                if payload.get("finished_at")
                else None
            ),
            exit_code=payload.get("exit_code"),
            pid=payload.get("pid"),
            output_tail=list(payload.get("output_tail", [])),
            summary=payload.get("summary"),
        )
