from xr_agent.session_runner import SessionRunner
from xr_agent.session_store import SessionStore


def test_start_command_runs_real_subprocess_and_captures_output(tmp_path) -> None:
    runner = SessionRunner(SessionStore())
    session = runner.start_command(
        repo_path=str(tmp_path),
        command="/bin/sh -c 'printf \"hello from runner\\n\"'",
        title="Runner smoke test",
    )

    completed = runner.wait(session.session_id, timeout=5)
    assert completed is not None
    assert completed.exit_code == 0
    assert completed.pid is not None
    assert "hello from runner" in completed.output_tail
