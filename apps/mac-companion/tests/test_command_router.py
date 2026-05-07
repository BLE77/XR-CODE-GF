from xr_agent.command_router import CommandRouter


def test_route_fix_and_rerun() -> None:
    router = CommandRouter()
    command = router.route("okay fix that and rerun")
    assert command.intent == "fix_and_rerun"


def test_route_open_codex_session() -> None:
    router = CommandRouter()
    command = router.route("open codex here")
    assert command.intent == "open_codex"


def test_route_open_claude_session_from_cloud_transcript() -> None:
    router = CommandRouter()
    command = router.route("open up a cloud session")
    assert command.intent == "open_claude_code"


def test_route_open_up_claude_project_session() -> None:
    router = CommandRouter()
    command = router.route("open up claude in the mac companion project")
    assert command.intent == "open_claude_code"


def test_route_open_up_codex_project_session() -> None:
    router = CommandRouter()
    command = router.route("open up codex in the xr coding agent repo")
    assert command.intent == "open_codex"


def test_route_open_kimi_code_session() -> None:
    router = CommandRouter()
    command = router.route("open kimi code here")
    assert command.intent == "open_kimi_code"


def test_route_open_kimi_session_from_voice_variant() -> None:
    router = CommandRouter()
    command = router.route("launch kimmy in the hackathon repo")
    assert command.intent == "open_kimi_code"


def test_route_polite_open_claude_session() -> None:
    router = CommandRouter()
    command = router.route("can you please open up claude in the mac companion project for me")
    assert command.intent == "open_claude_code"


def test_route_open_claude_session_from_quad_code_transcript() -> None:
    router = CommandRouter()
    command = router.route("can you open quad code claude code")
    assert command.intent == "open_claude_code"


def test_route_list_coding_sessions() -> None:
    router = CommandRouter()
    command = router.route("what coding sessions are open")
    assert command.intent == "list_coding_sessions"


def test_route_open_agents_to_worker_board() -> None:
    router = CommandRouter()
    command = router.route("open agents")
    assert command.intent == "list_coding_sessions"


def test_route_active_worker_attention_summary() -> None:
    router = CommandRouter()
    command = router.route("what needs me next across the active workers?")
    assert command.intent == "list_coding_sessions"


def test_route_send_to_claude_session() -> None:
    router = CommandRouter()
    command = router.route("tell claude fix the auth bug")

    assert command.intent == "send_to_coding_session"
    assert command.target == "open_claude_code"
    assert command.content == "fix the auth bug"


def test_route_have_claude_send_to_session() -> None:
    router = CommandRouter()
    command = router.route("have claude inspect the auth bug")

    assert command.intent == "send_to_coding_session"
    assert command.target == "open_claude_code"
    assert command.content == "inspect the auth bug"


def test_route_send_to_kimi_session() -> None:
    router = CommandRouter()
    command = router.route("tell kimi inspect the xr ui")

    assert command.intent == "send_to_coding_session"
    assert command.target == "open_kimi_code"
    assert command.content == "inspect the xr ui"


def test_route_summarize_codex_session() -> None:
    router = CommandRouter()
    command = router.route("what is codex doing")

    assert command.intent == "summarize_coding_session"
    assert command.target == "open_codex"


def test_route_summarize_kimi_session() -> None:
    router = CommandRouter()
    command = router.route("what is kimi doing")

    assert command.intent == "summarize_coding_session"
    assert command.target == "open_kimi_code"
