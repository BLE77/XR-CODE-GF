from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum


class SessionStatus(str, Enum):
    STARTING = "starting"
    RUNNING = "running"
    FINISHED = "finished"
    FAILED = "failed"


@dataclass
class Session:
    session_id: str
    title: str
    repo_path: str
    command: str
    status: SessionStatus
    started_at: datetime
    finished_at: datetime | None = None
    exit_code: int | None = None
    pid: int | None = None
    output_tail: list[str] = field(default_factory=list)
    summary: str | None = None


@dataclass
class AgentEvent:
    event_type: str
    ts: datetime
    session_id: str | None
    payload: dict


@dataclass
class WorkerSupervisorState:
    session_id: str
    intent: str
    worker_label: str
    repo_path: str
    title: str
    task_title: str
    worker_phase: str
    status_text: str
    manager_summary: str | None = None
    waiting_on_user: bool = False
    needs_review: bool = False
    blocked_reason: str | None = None
    pending_question: str | None = None
    last_update: str | None = None


@dataclass
class RoutedCommand:
    intent: str
    raw_text: str
    target: str | None = None
    content: str | None = None


@dataclass
class PendingDecisionRecord:
    session_id: str
    repo_path: str
    worker_label: str
    question: str
    decision_type: str
    created_at: datetime = field(default_factory=datetime.now)


@dataclass
class ProjectSupervisorState:
    repo_path: str
    active_task_title: str | None = None
    last_manager_summary: str | None = None
    worker_session_ids: list[str] = field(default_factory=list)
    pending_session_ids: list[str] = field(default_factory=list)
