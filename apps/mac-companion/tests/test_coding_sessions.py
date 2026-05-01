import sys
import time

from xr_agent.coding_sessions import CodingSessionTool, ManagedCodingSessionManager
from xr_agent.models import SessionStatus


def test_managed_coding_session_accepts_input_and_streams_output(tmp_path) -> None:
    manager = ManagedCodingSessionManager(
        log_dir=tmp_path / "logs",
        tools={
            "open_claude_code": CodingSessionTool(
                intent="open_claude_code",
                title="Claude Code",
                argv=(sys.executable, "-i", "-q"),
            )
        }
    )
    session = manager.start_session("open_claude_code", tmp_path)

    try:
        _wait_for(lambda: manager.get(session.session_id) is not None, timeout=3)
        manager.send_input(session.session_id, 'print("hello from claude")')

        _wait_for(
            lambda: any(
                "hello from claude" in line
                for line in (manager.get(session.session_id).output_tail or [])
            ),
            timeout=5,
        )

        manager.send_input(session.session_id, "raise SystemExit")
        _wait_for(
            lambda: manager.get(session.session_id).status in {SessionStatus.FINISHED, SessionStatus.FAILED},
            timeout=5,
        )
    finally:
        manager.shutdown()

    assert session.log_path is not None
    log_text = (tmp_path / "logs" / f"{session.session_id}.log").read_text(encoding="utf-8")
    assert "hello from claude" in log_text


def test_managed_coding_session_tracks_terminal_screen_snapshots(tmp_path) -> None:
    launcher = tmp_path / "ansi_launcher.py"
    launcher.write_text(
        "\n".join(
            [
                "import sys",
                "import time",
                "",
                "sys.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[H╭─╮\\n│A│\\n╰─╯')",
                "sys.stdout.flush()",
                "time.sleep(0.2)",
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
            lambda: "╭─╮" in (manager.get(session.session_id).screen_text or ""),
            timeout=5,
        )
        updated = manager.get(session.session_id)
        assert updated is not None
        assert updated.screen_text is not None
        assert "│A│" in updated.screen_text
        assert updated.screen_rows is not None
        assert updated.screen_columns is not None
    finally:
        manager.shutdown()


def test_managed_coding_session_overrides_dumb_term(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("TERM", "dumb")
    launcher = tmp_path / "print_term.py"
    launcher.write_text(
        "\n".join(
            [
                "import os",
                "",
                "print(f'TERM={os.environ.get(\"TERM\")}', flush=True)",
            ]
        ),
        encoding="utf-8",
    )

    manager = ManagedCodingSessionManager(
        tools={
            "open_codex": CodingSessionTool(
                intent="open_codex",
                title="Codex CLI",
                argv=(sys.executable, str(launcher)),
            )
        }
    )
    session = manager.start_session("open_codex", tmp_path)

    try:
        _wait_for(
            lambda: any(
                "TERM=xterm-256color" in line
                for line in (manager.get(session.session_id).output_tail or [])
            ),
            timeout=5,
        )
    finally:
        manager.shutdown()


def test_managed_coding_session_auto_accepts_cursor_encoded_trust_prompt(tmp_path) -> None:
    launcher = tmp_path / "claude_cursor_trust_prompt.py"
    launcher.write_text(
        "\n".join(
            [
                "import sys",
                "",
                "sys.stdout.write('Quick\\x1b[1Csafety\\x1b[1Ccheck: Is this a project you created or one you trust?\\n')",
                "sys.stdout.write('1. Yes,\\x1b[1CI\\x1b[1Ctrust\\x1b[1Cthis\\x1b[1Cfolder\\n')",
                "sys.stdout.write('Enter\\x1b[1Cto\\x1b[1Cconfirm\\n')",
                "sys.stdout.flush()",
                "line = sys.stdin.readline()",
                "if line == '\\n':",
                "    print('CLAUDE TRUSTED AND READY', flush=True)",
                "else:",
                "    print(f'UNEXPECTED INPUT: {line!r}', flush=True)",
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
    session = manager.start_session(
        "open_claude_code",
        tmp_path,
        auto_accept_trust_dialog=True,
    )

    try:
        _wait_for(
            lambda: any(
                "CLAUDE TRUSTED AND READY" in line
                for line in (manager.get(session.session_id).output_tail or [])
            ),
            timeout=5,
        )
        updated = manager.get(session.session_id)
        assert updated is not None
        assert updated.screen_text is not None
        assert "Quick" in updated.screen_text
    finally:
        manager.shutdown()


def test_managed_coding_session_auto_accepts_trust_then_bypass_prompt(tmp_path) -> None:
    launcher = tmp_path / "claude_trust_then_bypass.py"
    launcher.write_text(
        "\n".join(
            [
                "import sys",
                "",
                "print('Quick safety check: Is this a project you created or one you trust?', flush=True)",
                "print('Yes, I trust this folder', flush=True)",
                "print('Enter to confirm', flush=True)",
                "trust_line = sys.stdin.readline()",
                "if trust_line != '\\n':",
                "    print(f'UNEXPECTED TRUST INPUT: {trust_line!r}', flush=True)",
                "    raise SystemExit(1)",
                "print('TRUSTED', flush=True)",
                "print('WARNING: Claude Code running in Bypass Permissions mode', flush=True)",
                "print('1. No, exit', flush=True)",
                "print('2. Yes, I accept', flush=True)",
                "print('Enter to confirm', flush=True)",
                "bypass_line = sys.stdin.readline()",
                "if bypass_line == '\\x1b[B\\n':",
                "    print('BYPASS ACCEPTED', flush=True)",
                "else:",
                "    print(f'UNEXPECTED BYPASS INPUT: {bypass_line!r}', flush=True)",
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
    session = manager.start_session(
        "open_claude_code",
        tmp_path,
        auto_accept_trust_dialog=True,
    )

    try:
        _wait_for(
            lambda: any(
                "BYPASS ACCEPTED" in line
                for line in (manager.get(session.session_id).output_tail or [])
            ),
            timeout=5,
        )
    finally:
        manager.shutdown()


def test_managed_coding_session_tolerates_private_csi_sequences(tmp_path) -> None:
    launcher = tmp_path / "private_csi_launcher.py"
    launcher.write_text(
        "\n".join(
            [
                "import sys",
                "import time",
                "",
                "sys.stdout.write('\\x1b[>0qHello from Claude\\n')",
                "sys.stdout.flush()",
                "time.sleep(0.2)",
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
                "Hello from Claude" in line
                for line in (manager.get(session.session_id).output_tail or [])
            ),
            timeout=5,
        )
        updated = manager.get(session.session_id)
        assert updated is not None
        assert updated.screen_text is not None
        assert "Hello from Claude" in updated.screen_text
    finally:
        manager.shutdown()


def _wait_for(predicate, timeout: float) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError("condition was not met before timeout")
