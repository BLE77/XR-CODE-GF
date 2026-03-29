from datetime import datetime

from xr_agent.models import Session, SessionStatus
from xr_agent.session_store import SessionStore


def test_last_completed_returns_latest_finished_session() -> None:
    store = SessionStore()
    first = Session(
        session_id="a",
        title="first",
        repo_path="/tmp",
        command="echo first",
        status=SessionStatus.FINISHED,
        started_at=datetime.now(),
        summary="done",
    )
    second = Session(
        session_id="b",
        title="second",
        repo_path="/tmp",
        command="echo second",
        status=SessionStatus.FAILED,
        started_at=datetime.now(),
        summary="failed",
    )

    store.update(first)
    store.update(second)

    assert store.last_completed() is second


def test_store_persists_sessions(tmp_path) -> None:
    state_path = tmp_path / "sessions.json"
    store = SessionStore(state_path=state_path)
    session = Session(
        session_id="persisted",
        title="saved",
        repo_path=str(tmp_path),
        command="echo hi",
        status=SessionStatus.FINISHED,
        started_at=datetime.now(),
        summary="done",
        exit_code=0,
        pid=123,
        output_tail=["hi"],
    )

    store.update(session)

    reloaded = SessionStore(state_path=state_path)
    loaded = reloaded.get("persisted")
    assert loaded is not None
    assert loaded.pid == 123
    assert loaded.output_tail == ["hi"]
    assert reloaded.last_completed() is not None
