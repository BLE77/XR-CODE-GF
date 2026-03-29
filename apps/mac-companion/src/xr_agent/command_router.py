from __future__ import annotations

import re

from xr_agent.models import RoutedCommand

_POLITE_PREFIX_PATTERN = re.compile(
    r"^(?:(?:hey|ok(?:ay)?)\s+)?(?:(?:can|could|would|will)\s+you\s+|please\s+|i\s+want\s+you\s+to\s+|i\s+need\s+you\s+to\s+)*",
    re.IGNORECASE,
)

_SEND_CONTENT_PREFIX_PATTERN = re.compile(r"^(?:to\s+)", re.IGNORECASE)

_SEND_TO_SESSION_PATTERN = re.compile(
    r"^(?:ask|tell|send to|message|continue|have|get)\s+(claude|codex|hermes)\b[: ,.-]*(.*)$",
    re.IGNORECASE,
)

_SUMMARIZE_SESSION_PATTERN = re.compile(
    r"^(?:what is|what's|what did|summarize|check on)\s+(claude|codex|hermes)\b(?:\s+(?:doing|working on|up to|session|status))?.*$",
    re.IGNORECASE,
)

_CLOSE_SESSION_PATTERN = re.compile(
    r"^(?:close|quit|exit|stop)\s+(claude|codex|hermes)\b(?:\s+(?:code|session|terminal))?.*$",
    re.IGNORECASE,
)

_OPEN_CLAUDE_PATTERN = re.compile(
    r"\b(?:open(?: up)?|start(?: up)?|launch|spin up|boot up)\b.*\b(?:claude|cloud|quad code)\b",
    re.IGNORECASE,
)

_OPEN_CODEX_PATTERN = re.compile(
    r"\b(?:open(?: up)?|start(?: up)?|launch|spin up|boot up)\b.*\bcodex\b",
    re.IGNORECASE,
)

_OPEN_HERMES_PATTERN = re.compile(
    r"\b(?:open(?: up)?|start(?: up)?|launch|spin up|boot up)\b.*\bhermes\b",
    re.IGNORECASE,
)


class CommandRouter:
    def route(self, text: str) -> RoutedCommand:
        stripped = text.strip()
        lowered = stripped.lower()
        normalized = _normalize_polite_prefixes(stripped)
        send_match = _SEND_TO_SESSION_PATTERN.match(normalized)
        if send_match:
            tool_name = send_match.group(1).lower()
            content = _SEND_CONTENT_PREFIX_PATTERN.sub("", send_match.group(2).strip())
            target = {
                "claude": "open_claude_code",
                "codex": "open_codex",
                "hermes": "open_hermes_cli",
            }[tool_name]
            return RoutedCommand(
                intent="send_to_coding_session",
                raw_text=text,
                target=target,
                content=content,
            )

        summarize_match = _SUMMARIZE_SESSION_PATTERN.match(normalized)
        if summarize_match:
            tool_name = summarize_match.group(1).lower()
            target = {
                "claude": "open_claude_code",
                "codex": "open_codex",
                "hermes": "open_hermes_cli",
            }[tool_name]
            return RoutedCommand(
                intent="summarize_coding_session",
                raw_text=text,
                target=target,
            )

        close_match = _CLOSE_SESSION_PATTERN.match(normalized)
        if close_match:
            tool_name = close_match.group(1).lower()
            target = {
                "claude": "open_claude_code",
                "codex": "open_codex",
                "hermes": "open_hermes_cli",
            }[tool_name]
            return RoutedCommand(
                intent="close_coding_session",
                raw_text=text,
                target=target,
            )

        if _OPEN_CODEX_PATTERN.search(normalized):
            return RoutedCommand(intent="open_codex", raw_text=text)
        if _OPEN_CLAUDE_PATTERN.search(normalized) or "cloud session" in lowered or "quad code claude" in lowered:
            return RoutedCommand(intent="open_claude_code", raw_text=text)
        if _OPEN_HERMES_PATTERN.search(normalized):
            return RoutedCommand(intent="open_hermes_cli", raw_text=text)
        if (
            "open coding sessions" in lowered
            or "list coding sessions" in lowered
            or "what coding sessions are open" in lowered
            or "show terminals" in lowered
        ):
            return RoutedCommand(intent="list_coding_sessions", raw_text=text)
        if "fix" in lowered and "rerun" in lowered:
            return RoutedCommand(intent="fix_and_rerun", raw_text=text)
        if "rerun" in lowered:
            return RoutedCommand(intent="rerun_last", raw_text=text)
        if "what happened" in lowered:
            return RoutedCommand(intent="what_happened", raw_text=text)
        if "what's still running" in lowered or "what is still running" in lowered:
            return RoutedCommand(intent="list_active", raw_text=text)
        if "test" in lowered:
            return RoutedCommand(intent="run_tests", raw_text=text)
        if "build" in lowered:
            return RoutedCommand(intent="build_project", raw_text=text)

        return RoutedCommand(intent="generic_followup", raw_text=text)


def _normalize_polite_prefixes(text: str) -> str:
    normalized = text.strip()
    previous = None
    while normalized and previous != normalized:
        previous = normalized
        normalized = _POLITE_PREFIX_PATTERN.sub("", normalized, count=1).strip()
    return normalized or text.strip()
