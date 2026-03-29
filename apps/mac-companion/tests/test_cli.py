from types import SimpleNamespace

from xr_agent.main import main, parse_args


def test_parse_args_supports_repo_and_once_command() -> None:
    args = parse_args(["--repo", "/tmp/demo", "--once", "run tests"])

    assert args.repo == "/tmp/demo"
    assert args.once == "run tests"


def test_main_returns_session_exit_code_for_one_shot_commands(tmp_path, monkeypatch, capsys) -> None:
    class FakeApp:
        def __init__(self) -> None:
            self.started = 0
            self.stopped = 0
            self.events = SimpleNamespace(recent_serialized=lambda: [])

        def start(self) -> None:
            self.started += 1

        def stop(self) -> None:
            self.stopped += 1

        def handle_text(self, text: str, repo_path: str) -> dict[str, str]:
            return {"message": f"handled {text} in {repo_path}", "session_id": "sess-1"}

        def wait_for_session(self, session_id: str, timeout=None):
            assert session_id == "sess-1"
            return SimpleNamespace(exit_code=1, summary="tests failed")

    app = FakeApp()
    monkeypatch.setattr("xr_agent.main.build_app", lambda *args, **kwargs: app)

    exit_code = main(["--repo", str(tmp_path), "--once", "run tests"])

    assert exit_code == 1
    assert app.started == 1
    assert app.stopped == 1
    assert capsys.readouterr().out.strip().splitlines() == [
        f"handled run tests in {tmp_path}",
        "tests failed",
    ]
