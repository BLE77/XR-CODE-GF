import sys
import termios
import time
import tty

import pytest

from xr_agent.coding_sessions import CodingSessionTool, ManagedCodingSessionManager
from xr_agent.models import SessionStatus


def test_managed_coding_session_submits_with_carriage_return(tmp_path) -> None:
    launcher = tmp_path / "submit_key_launcher.py"
    launcher.write_text(
        "\n".join(
            [
                "import os",
                "import sys",
                "import termios",
                "import tty",
                "",
                "fd = sys.stdin.fileno()",
                "original = termios.tcgetattr(fd)",
                "tty.setraw(fd)",
                "sys.stdout.write('READY> ')",
                "sys.stdout.flush()",
                "buffer = bytearray()",
                "try:",
                "    while True:",
                "        chunk = os.read(fd, 1)",
                "        if not chunk:",
                "            break",
                "        if chunk == b'\\r':",
                "            sys.stdout.write('SUBMITTED:' + buffer.decode('utf-8', 'replace') + '\\n')",
                "            sys.stdout.flush()",
                "            break",
                "        if chunk == b'\\n':",
                "            sys.stdout.write('WRONG_NEWLINE\\n')",
                "            sys.stdout.flush()",
                "            break",
                "        buffer.extend(chunk)",
                "finally:",
                "    termios.tcsetattr(fd, termios.TCSADRAIN, original)",
            ]
        ),
        encoding="utf-8",
    )

    manager = ManagedCodingSessionManager(
        tools={
            "open_claude_code": CodingSessionTool(
                intent="open_claude_code",
                title="Claude Code",
                argv=(sys.executable, str(launcher)),
            )
        }
    )
    session = manager.start_session("open_claude_code", tmp_path)

    try:
        _wait_for(
            lambda: any("READY>" in line for line in (manager.get(session.session_id).output_tail or [])),
            timeout=5,
        )
        manager.send_input(session.session_id, "look at our code base")
        _wait_for(
            lambda: any(
                "SUBMITTED:look at our code base" in line
                for line in (manager.get(session.session_id).output_tail or [])
            ),
            timeout=5,
        )
        updated = manager.get(session.session_id)
        assert updated is not None
        assert not any("WRONG_NEWLINE" in line for line in (updated.output_tail or []))
    finally:
        manager.shutdown()


def test_managed_coding_session_close_session_terminates_worker_group(tmp_path) -> None:
    launcher = tmp_path / "close_group_launcher.py"
    launcher.write_text(
        "\n".join(
            [
                "import subprocess",
                "import sys",
                "import time",
                "",
                "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(10)'])",
                "print('PARENT READY', flush=True)",
                "time.sleep(10)",
            ]
        ),
        encoding="utf-8",
    )

    manager = ManagedCodingSessionManager(
        tools={
            "open_claude_code": CodingSessionTool(
                intent="open_claude_code",
                title="Claude Code",
                argv=(sys.executable, str(launcher)),
            )
        }
    )
    session = manager.start_session("open_claude_code", tmp_path)

    try:
        _wait_for(
            lambda: any(
                "PARENT READY" in line
                for line in (manager.get(session.session_id).output_tail or [])
            ),
            timeout=5,
        )

        closed = manager.close_session(session.session_id)
        _wait_for(
            lambda: manager.get(session.session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
            timeout=5,
        )

        updated = manager.get(session.session_id)
        assert updated is not None
        assert updated.status in {SessionStatus.FINISHED, SessionStatus.FAILED}
        assert closed is not None

        with pytest.raises((RuntimeError, KeyError)):
            manager.send_input(session.session_id, "still there?")
    finally:
        manager.shutdown()


def _wait_for(predicate, timeout: float) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError("condition was not met before timeout")
