from __future__ import annotations

from xr_agent.models import Session, SessionStatus


class Summarizer:
    def summarize(self, session: Session) -> str:
        if session.status == SessionStatus.FINISHED:
            tail = f" Last output: {session.output_tail[-1]}" if session.output_tail else ""
            return f"{session.title} finished successfully with exit code 0.{tail}"
        if session.status == SessionStatus.FAILED:
            if session.output_tail:
                return (
                    f"{session.title} failed with exit code {session.exit_code}. "
                    f"Last output: {session.output_tail[-1]}"
                )
            return f"{session.title} failed with exit code {session.exit_code}."
        return f"{session.title} is still running."
