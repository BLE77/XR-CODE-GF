from datetime import datetime
from pathlib import Path

from xr_agent.hermes_adapter import HermesAdapter
from xr_agent.models import Session, SessionStatus


def test_build_fix_and_rerun_prompt_substitutes_context_fields(tmp_path) -> None:
    prompt_template = tmp_path / "followup_prompt.md"
    prompt_template.write_text(
        "repo={repo_path}\ncmd={previous_command}\nstatus={previous_status}\nsummary={previous_summary}\nout={output_tail}\nfollowup={user_followup}\n",
        encoding="utf-8",
    )
    adapter = HermesAdapter(hermes_cmd="hermes", prompt_template_path=prompt_template)
    session = Session(
        session_id="done-1",
        title="Broken tests",
        repo_path="/tmp/demo",
        command="pytest -q",
        status=SessionStatus.FAILED,
        started_at=datetime.now(),
        finished_at=datetime.now(),
        exit_code=1,
        output_tail=["line 1", "line 2"],
        summary="tests failed",
    )

    prompt = adapter.build_fix_and_rerun_prompt(session, "fix that and rerun")

    assert prompt == (
        "repo=/tmp/demo\n"
        "cmd=pytest -q\n"
        "status=failed\n"
        "summary=tests failed\n"
        "out=line 1\nline 2\n"
        "followup=fix that and rerun\n"
    )
    assert "{repo_path}" not in prompt
    assert "{user_followup}" not in prompt


def test_shared_followup_prompt_template_renders_without_placeholders() -> None:
    shared_template = Path(__file__).resolve().parents[3] / "shared" / "prompts" / "followup_prompt.md"
    adapter = HermesAdapter(hermes_cmd="hermes", prompt_template_path=shared_template)
    session = Session(
        session_id="done-2",
        title="Broken build",
        repo_path="/tmp/repo",
        command="npm run build",
        status=SessionStatus.FAILED,
        started_at=datetime.now(),
        finished_at=datetime.now(),
        exit_code=1,
        output_tail=["TypeError: boom"],
        summary="Build failed.",
    )

    prompt = adapter.build_fix_and_rerun_prompt(session, "fix that and rerun")

    assert "/tmp/repo" in prompt
    assert "npm run build" in prompt
    assert "TypeError: boom" in prompt
    assert "fix that and rerun" in prompt
    assert "{repo_path}" not in prompt
    assert "{previous_command}" not in prompt
    assert "{output_tail}" not in prompt
    assert "{user_followup}" not in prompt


def test_build_cli_command_uses_quiet_programmatic_mode(tmp_path) -> None:
    prompt_template = tmp_path / "followup_prompt.md"
    prompt_template.write_text("hello", encoding="utf-8")
    adapter = HermesAdapter(hermes_cmd="hermes", prompt_template_path=prompt_template)

    command = adapter.build_cli_command("Say hello")

    assert command == ["hermes", "chat", "--quiet", "-q", "Say hello"]


def test_extract_assistant_reply_strips_hermes_metadata(tmp_path) -> None:
    prompt_template = tmp_path / "followup_prompt.md"
    prompt_template.write_text("hello", encoding="utf-8")
    adapter = HermesAdapter(hermes_cmd="hermes", prompt_template_path=prompt_template)

    output = """
⚠️  API call failed (attempt 1/3): APIError
📊 Request context: 2 messages, ~4,464 tokens, 34 tools
Hello, Bless.

session_id: 20260318_015050_1b080a
"""

    assert adapter.extract_assistant_reply(output) == "Hello, Bless."
