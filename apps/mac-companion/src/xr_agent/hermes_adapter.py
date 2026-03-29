from __future__ import annotations

import re
from pathlib import Path

from xr_agent.models import Session


_BOX_DRAWING_LINE = re.compile(r"^[\s\-\─╭╮╰╯│├┤┬┴┼]+$")
_SESSION_TRAILER_PREFIXES = (
    "resume this session with:",
    "session:",
    "duration:",
    "messages:",
    "session_id:",
)
_NOISY_PREFIXES = (
    "⚠️",
    "⏱️",
    "📝",
    "📊",
    "query:",
    "────────────────",
    "╭",
    "╰",
    "│",
)
_NOISY_CONTAINS = (
    "hermes agent v",
    "available tools",
    "available skills",
    "tools ·",
    "commits behind",
)


class HermesAdapter:
    def __init__(self, hermes_cmd: str, prompt_template_path: Path) -> None:
        self.hermes_cmd = hermes_cmd
        self.prompt_template_path = prompt_template_path

    def build_fix_and_rerun_prompt(self, session: Session, user_followup: str) -> str:
        template = self.prompt_template_path.read_text(encoding="utf-8")
        return template.format(
            repo_path=session.repo_path,
            previous_command=session.command,
            previous_status=session.status.value,
            previous_summary=session.summary or "",
            output_tail="\n".join(session.output_tail),
            user_followup=user_followup,
        )

    def build_cli_command(self, prompt: str) -> list[str]:
        return [self.hermes_cmd, "chat", "--quiet", "-q", prompt]

    def is_hermes_command(self, command: str) -> bool:
        normalized = command.strip()
        hermes_name = Path(self.hermes_cmd).name
        return normalized.startswith(f"{self.hermes_cmd} ") or normalized.startswith(f"{hermes_name} ")

    def extract_assistant_reply(self, output: str) -> str:
        paragraphs: list[str] = []
        current_paragraph: list[str] = []

        for raw_line in output.splitlines():
            stripped = raw_line.strip()
            lowered = stripped.lower()

            if not stripped:
                if current_paragraph:
                    paragraphs.append(" ".join(current_paragraph).strip())
                    current_paragraph = []
                continue

            if lowered.startswith(_SESSION_TRAILER_PREFIXES):
                break

            if lowered.startswith(_NOISY_PREFIXES):
                continue

            if any(token in lowered for token in _NOISY_CONTAINS):
                continue

            if _BOX_DRAWING_LINE.match(stripped):
                continue

            current_paragraph.append(stripped)

        if current_paragraph:
            paragraphs.append(" ".join(current_paragraph).strip())

        return "\n\n".join(paragraph for paragraph in paragraphs if paragraph).strip()
