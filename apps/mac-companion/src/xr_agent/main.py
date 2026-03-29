from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from xr_agent.command_catalog import resolve_repo_commands
from xr_agent.command_center import (
    CommandCenterControlClient,
    CommandCenterProject,
    CommandCenterServer,
    CommandCenterStateStore,
)
from xr_agent.command_router import CommandRouter
from xr_agent.config import AppConfig
from xr_agent.control_server import ControlServer
from xr_agent.coding_sessions import ManagedCodingSession, ManagedCodingSessionManager
from xr_agent.event_server import EventServer, make_event
from xr_agent.hermes_adapter import HermesAdapter
from xr_agent.hermes_plugin import install_managed_session_plugin
from xr_agent.hermes_runtime import PersistentHermesRuntime
from xr_agent.models import (
    PendingDecisionRecord,
    ProjectSupervisorState,
    RoutedCommand,
    Session,
    SessionStatus,
    WorkerSupervisorState,
)
from xr_agent.session_runner import SessionRunner
from xr_agent.session_store import SessionStore
from xr_agent.speech_service import SpeechService
from xr_agent.summarizer import Summarizer


class XRAgentApp:
    def __init__(
        self,
        *,
        config: AppConfig,
        store: SessionStore,
        runner: SessionRunner,
        router: CommandRouter,
        speech: SpeechService,
        summarizer: Summarizer,
        hermes: HermesAdapter,
        hermes_runtime: PersistentHermesRuntime,
        coding_sessions: ManagedCodingSessionManager,
        events: EventServer,
        control: ControlServer,
    ) -> None:
        self.config = config
        self.store = store
        self.runner = runner
        self.router = router
        self.speech = speech
        self.summarizer = summarizer
        self.hermes = hermes
        self.hermes_runtime = hermes_runtime
        self.coding_sessions = coding_sessions
        self.events = events
        self.control = control
        self._previous_control_environment: dict[str, str | None] | None = None
        self._worker_counts_by_intent: dict[tuple[str, str], int] = {}
        self._workers_by_session_id: dict[str, WorkerSupervisorState] = {}
        self._pending_decisions_by_session_id: dict[str, PendingDecisionRecord] = {}
        self._project_states_by_repo_path: dict[str, ProjectSupervisorState] = {}
        self._command_center: CommandCenterServer | None = None
        self._command_center_url: str | None = None

    def start(self) -> None:
        try:
            self._install_hermes_managed_session_plugin()
            self.control.start_in_background(self.config.control_host, self.config.control_port)
            self._configure_hermes_session_control_environment()
            self._start_command_center()
            self.events.start_in_background(self.config.event_host, self.config.event_port)
            self.hermes_runtime.start()
            self.hermes_runtime.warm_session(self.config.default_repo_path)
        except Exception:
            self.stop()
            raise

    def stop(self) -> None:
        self._stop_command_center()
        self.coding_sessions.shutdown()
        self.hermes_runtime.stop()
        self.events.stop_in_background()
        self.control.stop_in_background()
        self._restore_hermes_session_control_environment()

    @property
    def command_center_url(self) -> str | None:
        return self._command_center_url

    def handle_text(self, text: str, repo_path: str | None = None) -> dict[str, Any]:
        target_repo_path = self._resolve_requested_repo_path(repo_path) or str(self.config.default_repo_path)
        transcript = self.speech.transcribe(text)
        target_repo_path, transcript = self._resolve_repo_path_from_transcript(target_repo_path, transcript)
        self._set_current_repo_focus(target_repo_path)
        explicit_worker_reply = self._handle_explicit_worker_instruction(transcript, repo_path=target_repo_path)
        if explicit_worker_reply is not None:
            return explicit_worker_reply
        routed = self.router.route(transcript)
        if routed.intent == "generic_followup":
            authoritative = self._authoritative_coding_session_route(transcript)
            if authoritative is not None:
                routed = authoritative
        self.events.publish(make_event("speech.transcript", None, {"text": transcript, "intent": routed.intent}))
        self.events.publish(make_event("avatar.thinking", None, {"text": transcript}))
        if (
            routed.intent == "generic_followup"
            and self._has_pending_worker_question(repo_path=target_repo_path)
            and self._looks_like_pending_worker_reply(transcript)
        ):
            return self._reply_to_pending_worker(transcript, repo_path=target_repo_path)

        if routed.intent == "what_happened":
            return self._respond(self._what_happened())
        if routed.intent == "list_active":
            return self._respond(self._list_active())
        if routed.intent == "list_coding_sessions":
            return self._respond(self.coding_sessions.summarize_open_sessions())
        if routed.intent in {"open_codex", "open_claude_code", "open_hermes_cli"}:
            return self._launch_coding_session(routed.intent, target_repo_path, routed.raw_text)
        if routed.intent == "close_coding_session":
            return self._close_coding_session(routed.target, repo_path=target_repo_path)
        if routed.intent == "send_to_coding_session":
            return self._send_to_coding_session(routed.target, routed.content, repo_path=target_repo_path)
        if routed.intent == "summarize_coding_session":
            return self._summarize_coding_session(routed.target, repo_path=target_repo_path)
        if routed.intent == "rerun_last":
            return self._rerun_last()
        repo_commands = resolve_repo_commands(target_repo_path)

        if routed.intent == "fix_and_rerun":
            return self._fix_and_rerun(transcript)
        if routed.intent == "run_tests":
            return self._start_session(target_repo_path, repo_commands.test_command, "Run tests")
        if routed.intent == "build_project":
            return self._start_session(target_repo_path, repo_commands.build_command, "Build project")
        if routed.intent == "generic_followup":
            if self._looks_like_unresolved_coding_session_request(transcript) and not self._can_delegate_session_management_to_hermes():
                return self._start_supervised_followup(target_repo_path, transcript)
            return self._start_generic_followup(target_repo_path, transcript)
        return self._start_generic_followup(target_repo_path, transcript)

    def handle_client_message(self, message: dict[str, Any]) -> None:
        message_type = message.get("type")
        payload = message.get("payload", {})
        if not isinstance(payload, dict):
            return

        if message_type == "voice.command":
            transcript = payload.get("text")
            repo_path = payload.get("repo_path")

            if not isinstance(transcript, str) or not transcript.strip():
                self.events.publish(
                    make_event(
                        "agent.summary",
                        None,
                        {"text": "I did not receive a usable voice command."},
                    )
                )
                return

            try:
                self.handle_text(transcript, repo_path=repo_path if isinstance(repo_path, str) else None)
            except Exception as exc:  # pragma: no cover - defensive path
                self.events.publish(
                    make_event(
                        "session.failed",
                        None,
                        {"summary": f"Failed to process voice command: {exc}"},
                    )
                )
                self.events.publish(
                    make_event(
                        "agent.summary",
                        None,
                        {"text": f"Failed to process voice command: {exc}"},
                    )
                )
            return

        if message_type == "coding_session.open":
            intent = payload.get("intent")
            repo_path = payload.get("repo_path")
            dangerous_skip = payload.get("dangerously_skip_permissions")
            if not isinstance(intent, str) or not isinstance(repo_path, str):
                return
            try:
                self._launch_coding_session(
                    intent,
                    repo_path,
                    "",
                    requested_dangerous_skip=bool(dangerous_skip),
                )
            except Exception as exc:  # pragma: no cover - websocket path is integration-heavy
                self.events.publish(
                    make_event(
                        "assistant.reply",
                        None,
                        {"text": f"Could not open that coding session: {exc}"},
                    )
                )
            return

        if message_type == "coding_session.close":
            session_id = payload.get("session_id")
            if not isinstance(session_id, str):
                return
            try:
                self._close_coding_session_by_id(session_id)
            except Exception as exc:  # pragma: no cover - websocket path is integration-heavy
                self.events.publish(
                    make_event(
                        "assistant.reply",
                        session_id,
                        {"text": f"Could not close that coding session: {exc}"},
                    )
                )
            return

        if message_type == "coding_session.open_log":
            session_id = payload.get("session_id")
            if not isinstance(session_id, str):
                return
            try:
                session = self.coding_sessions.open_session_log_in_terminal(session_id)
                self.events.publish(
                    make_event(
                        "assistant.reply",
                        session.session_id,
                        {"text": f"Opened {session.title} log on your Mac."},
                    )
                )
            except Exception as exc:  # pragma: no cover - desktop integration path
                self.events.publish(
                    make_event(
                        "assistant.reply",
                        session_id,
                        {"text": f"Could not open that session log on your Mac: {exc}"},
                    )
                )
            return

        if message_type == "coding_session.reveal_log":
            session_id = payload.get("session_id")
            if not isinstance(session_id, str):
                return
            try:
                session = self.coding_sessions.reveal_session_log(session_id)
                self.events.publish(
                    make_event(
                        "assistant.reply",
                        session.session_id,
                        {"text": f"Revealed {session.title} log in Finder."},
                    )
                )
            except Exception as exc:  # pragma: no cover - desktop integration path
                self.events.publish(
                    make_event(
                        "assistant.reply",
                        session_id,
                        {"text": f"Could not reveal that session log: {exc}"},
                    )
                )
            return

        if message_type == "coding_sessions.sync":
            self._publish_coding_session_snapshot()
            return

        if message_type == "worker.reply":
            session_id = payload.get("session_id")
            text = payload.get("text")
            route_via_manager = payload.get("route_via_manager")
            if not isinstance(session_id, str) or not isinstance(text, str):
                return
            try:
                self._handle_worker_reply_message(
                    session_id=session_id,
                    text=text,
                    route_via_manager=bool(True if route_via_manager is None else route_via_manager),
                )
            except Exception as exc:  # pragma: no cover - websocket path is integration-heavy
                self.events.publish(
                    make_event(
                        "assistant.reply",
                        session_id,
                        {"text": f"Could not send that worker reply: {exc}"},
                    )
                )
            return

        if message_type == "project.pick_folder":
            starting_path = payload.get("starting_path")
            try:
                selected_path = self._pick_project_folder_on_mac(
                    starting_path if isinstance(starting_path, str) else None
                )
            except Exception as exc:  # pragma: no cover - desktop integration path
                self.events.publish(
                    make_event(
                        "assistant.reply",
                        None,
                        {"text": f"Could not open the Mac project picker: {exc}"},
                    )
                )
                return

            if selected_path is None:
                self.events.publish(
                    make_event(
                        "hermes.status",
                        None,
                        {"text": "Project picker was cancelled on your Mac."},
                    )
                )
                return

            self.events.publish(
                make_event(
                    "project.selected",
                    None,
                    {"path": selected_path},
                )
            )
            self._set_current_repo_focus(selected_path)
            self.events.publish(
                make_event(
                    "hermes.status",
                    None,
                    {"text": f"Current project set to {selected_path}."},
                )
            )
            return

        if message_type == "terminal.input":
            session_id = payload.get("session_id")
            text = payload.get("text")
            if not isinstance(session_id, str) or not isinstance(text, str):
                return
            try:
                self._write_to_coding_session(session_id, text)
                self._resolve_pending_worker_after_direct_input(session_id, text)
            except Exception as exc:  # pragma: no cover - websocket path is integration-heavy
                self.events.publish(
                    make_event(
                        "assistant.reply",
                        session_id,
                        {"text": f"Could not send that to the coding session: {exc}"},
                    )
                )
            return

    def handle_control_request(self, request: dict[str, Any]) -> dict[str, Any]:
        action = request.get("action")
        if not isinstance(action, str) or not action.strip():
            return {"ok": False, "error": "Control requests need an action."}

        normalized_action = action.strip().lower()
        if normalized_action == "list_sessions":
            include_finished = bool(request.get("include_finished"))
            sessions = self.coding_sessions.list_sessions()
            if not include_finished:
                sessions = [
                    session
                    for session in sessions
                    if session.status in {SessionStatus.STARTING, SessionStatus.RUNNING}
                ]
            return {
                "ok": True,
                "action": normalized_action,
                "sessions": [self._control_session_payload(session) for session in sessions],
            }

        if normalized_action == "recent_events":
            limit = request.get("limit")
            try:
                parsed_limit = int(limit) if limit is not None else 24
            except (TypeError, ValueError):
                parsed_limit = 24
            parsed_limit = max(1, min(parsed_limit, 100))
            events = self.events.recent_serialized()
            return {
                "ok": True,
                "action": normalized_action,
                "events": events[-parsed_limit:],
            }

        tool_name = request.get("tool")
        repo_path = request.get("repo_path")
        session_id = request.get("session_id")
        session_repo_path = repo_path if isinstance(repo_path, str) and repo_path.strip() else None

        try:
            if normalized_action == "open_session":
                if not isinstance(repo_path, str) or not repo_path.strip():
                    return {"ok": False, "error": "open_session needs a repo_path."}
                intent = self._intent_for_tool_name(tool_name)
                if intent is None:
                    return {"ok": False, "error": "open_session needs tool=claude, codex, or hermes."}

                resolved_repo_path = str(Path(repo_path).expanduser().resolve())
                reuse_existing = bool(request.get("reuse_existing", True))
                session = (
                    self._latest_open_coding_session(intent, resolved_repo_path)
                    if reuse_existing
                    else None
                )
                reused = session is not None
                if session is None:
                    session = self._start_managed_coding_session(
                        intent,
                        resolved_repo_path,
                        "",
                        requested_dangerous_skip=bool(request.get("dangerously_skip_permissions")),
                    )
                return {
                    "ok": True,
                    "action": normalized_action,
                    "reused": reused,
                    "session": self._control_session_payload(session),
                }

            session = self._resolve_control_session(
                tool_name=tool_name if isinstance(tool_name, str) else None,
                session_id=session_id if isinstance(session_id, str) else None,
                repo_path=session_repo_path,
            )

            if normalized_action == "send_session_input":
                text = request.get("text")
                if not isinstance(text, str) or not text.strip():
                    return {"ok": False, "error": "send_session_input needs text."}
                self._write_to_coding_session(session.session_id, text)
                current = self.coding_sessions.get(session.session_id) or session
                return {
                    "ok": True,
                    "action": normalized_action,
                    "session": self._control_session_payload(current),
                    "sent_text": text,
                }

            if normalized_action == "read_session_screen":
                current = self.coding_sessions.get(session.session_id) or session
                return {
                    "ok": True,
                    "action": normalized_action,
                    "session": self._control_session_payload(current),
                }

            if normalized_action == "close_session":
                closed = self.coding_sessions.close_session(session.session_id)
                return {
                    "ok": True,
                    "action": normalized_action,
                    "session": self._control_session_payload(closed),
                }
        except Exception as exc:
            return {"ok": False, "action": normalized_action, "error": str(exc)}

        return {"ok": False, "error": f"Unsupported control action: {normalized_action}"}

    def wait_for_session(self, session_id: str, timeout: float | None = None) -> Session | None:
        return self.runner.wait(session_id, timeout=timeout)

    def _install_hermes_managed_session_plugin(self) -> None:
        install_managed_session_plugin()

    def _configure_hermes_session_control_environment(self) -> None:
        bound_port = self.control.bound_port
        if bound_port is None:
            raise RuntimeError("Hermes managed-session control server did not bind to a port.")
        self._previous_control_environment = {
            "XR_AGENT_CONTROL_HOST": os.environ.get("XR_AGENT_CONTROL_HOST"),
            "XR_AGENT_CONTROL_PORT": os.environ.get("XR_AGENT_CONTROL_PORT"),
        }
        os.environ["XR_AGENT_CONTROL_HOST"] = self._control_bridge_connect_host()
        os.environ["XR_AGENT_CONTROL_PORT"] = str(bound_port)

    def _restore_hermes_session_control_environment(self) -> None:
        if self._previous_control_environment is None:
            return

        for name, previous_value in self._previous_control_environment.items():
            if previous_value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = previous_value
        self._previous_control_environment = None

    def _control_bridge_connect_host(self) -> str:
        normalized = self.config.control_host.strip()
        if normalized in {"", "0.0.0.0"}:
            return "127.0.0.1"
        if normalized == "::":
            return "::1"
        return normalized

    def _start_command_center(self) -> None:
        if not self.config.command_center_enabled:
            return
        control_port = self.control.bound_port
        if control_port is None:
            raise RuntimeError("Cannot start command center before the control bridge is available.")
        state_store = CommandCenterStateStore(
            control_client=CommandCenterControlClient(self._control_bridge_connect_host(), control_port),
            default_repo_path=str(self.config.default_repo_path),
            command_center_url="http://127.0.0.1",
            event_stream_url=f"ws://{self._event_stream_connect_host()}:{self.config.event_port}",
            saved_projects=self._command_center_projects(),
        )
        server = CommandCenterServer(state_store)
        self._command_center_url = server.start_in_background(
            host=self.config.command_center_host,
            port=self.config.command_center_port,
            open_browser=self.config.command_center_open_browser,
        )
        self._command_center = server

    def _stop_command_center(self) -> None:
        if self._command_center is not None:
            self._command_center.stop_in_background()
        self._command_center = None
        self._command_center_url = None

    def _command_center_projects(self) -> list[CommandCenterProject]:
        projects: list[CommandCenterProject] = []
        seen: set[str] = set()
        for candidate in (self.config.default_repo_path, *self.config.project_search_roots):
            path = candidate.expanduser().resolve()
            normalized = str(path)
            if normalized in seen:
                continue
            seen.add(normalized)
            projects.append(CommandCenterProject(label=path.name or normalized, path=normalized))
        return projects

    def _event_stream_connect_host(self) -> str:
        normalized = self.config.event_host.strip()
        if normalized in {"", "0.0.0.0"}:
            return "127.0.0.1"
        if normalized == "::":
            return "::1"
        return normalized

    def _pick_project_folder_on_mac(self, starting_path: str | None = None) -> str | None:
        script = [
            'set pickerPrompt to "Choose a project folder for XR Coding Agent"',
        ]

        default_location = self._normalize_picker_default_path(starting_path)
        if default_location is not None:
            script.extend(
                [
                    f"set defaultLocation to POSIX file {json.dumps(default_location)}",
                    "set chosenFolder to choose folder with prompt pickerPrompt default location defaultLocation",
                ]
            )
        else:
            script.append("set chosenFolder to choose folder with prompt pickerPrompt")

        script.append("POSIX path of chosenFolder")

        try:
            completed = subprocess.run(
                ["osascript", *sum([["-e", line] for line in script], [])],
                check=True,
                capture_output=True,
                text=True,
            )
        except subprocess.CalledProcessError as exc:
            stderr = (exc.stderr or "").strip()
            if "User canceled" in stderr:
                return None
            raise RuntimeError(stderr or "AppleScript project picker failed.") from exc
        except FileNotFoundError as exc:
            raise RuntimeError("osascript is not available on this Mac.") from exc

        selected = completed.stdout.strip()
        if not selected:
            return None
        return str(Path(selected).expanduser().resolve())

    def _normalize_picker_default_path(self, raw_path: str | None) -> str | None:
        candidates: list[Path] = []
        if raw_path:
            candidates.append(Path(raw_path).expanduser())
        candidates.append(self.config.default_repo_path.expanduser())
        candidates.append(Path.home() / "Desktop")
        candidates.append(Path.home())

        for candidate in candidates:
            if candidate.exists():
                target = candidate if candidate.is_dir() else candidate.parent
                return str(target.resolve())
        return None

    def _start_session(
        self,
        repo_path: str,
        command: str,
        title: str,
        *,
        argv: list[str] | None = None,
        shell: bool = True,
    ) -> dict[str, Any]:
        session = self.runner.start_command(
            repo_path=repo_path,
            command=command,
            title=title,
            argv=argv,
            shell=shell,
            on_started=self._on_session_started,
            on_output=self._on_session_output,
            on_finished=self._on_session_finished,
        )
        return {
            "message": self.speech.speak(f"Started {title.lower()} in {repo_path}."),
            "session_id": session.session_id,
            "intent": title,
        }

    def _rerun_last(self) -> dict[str, Any]:
        session = self.store.last_completed()
        if session is None:
            return self._respond("There is no completed session to rerun yet.")
        return self._start_session(session.repo_path, session.command, f"Rerun: {session.title}")

    def _fix_and_rerun(self, transcript: str) -> dict[str, Any]:
        session = self.store.last_completed()
        if session is None:
            return self._respond("There is no completed session to fix and rerun yet.")
        prompt = self.hermes.build_fix_and_rerun_prompt(session, transcript)
        return self._ask_hermes(
            session.repo_path,
            title=f"Fix and rerun: {session.title}",
            prompt=prompt,
        )

    def _start_generic_followup(self, repo_path: str, transcript: str) -> dict[str, Any]:
        target_repo_path = self._preferred_followup_repo_path(repo_path)
        last_session = self.store.last_completed()
        prompt = transcript
        if last_session is not None and last_session.repo_path == target_repo_path:
            prompt = self.hermes.build_fix_and_rerun_prompt(last_session, transcript)
        return self._ask_hermes(
            target_repo_path,
            title="Hermes follow-up",
            prompt=prompt,
        )

    def _what_happened(self) -> str:
        for session in self.store.completed_sessions():
            summary = self._user_facing_summary(session)
            if summary:
                return summary
        return "No session has completed yet."

    def _list_active(self) -> str:
        active = self.store.list_active()
        if not active:
            return "Nothing is still running."
        names = ", ".join(f"{session.title} ({session.session_id})" for session in active)
        return f"Still running: {names}"

    def _respond(self, text: str) -> dict[str, Any]:
        spoken = self.speech.speak(text)
        self.events.publish(make_event("avatar.speaking", None, {"text": spoken}))
        self.events.publish(make_event("assistant.reply", None, {"text": spoken}))
        self.events.publish(make_event("agent.summary", None, {"text": spoken}))
        return {"message": spoken}

    def _authoritative_coding_session_route(self, transcript: str) -> RoutedCommand | None:
        normalized = re.sub(
            r"\b(?:please|for me|thanks|thank you|i want to|i want you to|i need you to|would you|could you|can you|hey hermes|hermes)\b",
            " ",
            transcript,
            flags=re.IGNORECASE,
        )
        normalized = re.sub(r"\s+", " ", normalized).strip(" ,.-")
        if not normalized:
            return None

        routed = self.router.route(normalized)
        if routed.intent == "generic_followup":
            return None
        return RoutedCommand(
            intent=routed.intent,
            raw_text=transcript,
            target=routed.target,
            content=routed.content,
        )

    def _looks_like_unresolved_coding_session_request(self, transcript: str) -> bool:
        normalized = transcript.lower()
        mentions_tool = any(
            token in normalized
            for token in (
                "claude",
                "cloud",
                "quad code",
                "codex",
                "hermes",
            )
        )
        if not mentions_tool:
            return False

        action_markers = (
            "open",
            "launch",
            "start",
            "spin up",
            "boot up",
            "close",
            "quit",
            "stop",
            "tell",
            "ask",
            "message",
            "send",
            "continue",
            "summarize",
            "what is",
            "what's",
            "check on",
            "working on",
            "session",
        )
        return any(marker in normalized for marker in action_markers)

    def _unresolved_coding_session_message(self) -> str:
        return (
            "I understood that as a Claude, Codex, or Hermes session request, "
            "but I could not map it safely, so I did not fake the action. "
            "Try 'open claude here', 'tell claude ...', 'close claude', or use the project buttons."
        )

    def _launch_coding_session(
        self,
        intent: str,
        repo_path: str,
        transcript: str,
        *,
        requested_dangerous_skip: bool = False,
    ) -> dict[str, Any]:
        try:
            session = self._start_managed_coding_session(
                intent,
                repo_path,
                transcript,
                requested_dangerous_skip=requested_dangerous_skip,
            )
        except FileNotFoundError as exc:
            return self._respond(str(exc))
        except Exception as exc:  # pragma: no cover - host CLI/runtime depends on environment
            return self._respond(f"Could not open {intent.replace('_', ' ')}: {exc}")

        spoken = self._publish_coding_session_reply(
            session,
            f"Okay, opened {session.title} in this project.",
        )
        return {
            "message": spoken,
            "session_id": session.session_id,
            "intent": session.intent,
            "title": session.title,
            "repo_path": session.repo_path,
            "status": session.status.value,
            "pid": session.pid,
        }

    def _start_managed_coding_session(
        self,
        intent: str,
        repo_path: str,
        transcript: str,
        *,
        requested_dangerous_skip: bool = False,
    ) -> ManagedCodingSession:
        extra_args = self._coding_session_extra_args(
            intent,
            transcript,
            requested_dangerous_skip=requested_dangerous_skip,
        )
        auto_accept_trust_dialog = intent == "open_claude_code"
        return self.coding_sessions.start_session(
            intent,
            repo_path,
            extra_args=extra_args,
            auto_accept_trust_dialog=auto_accept_trust_dialog,
            on_started=self._on_coding_session_started,
            on_output=self._on_coding_session_output,
            on_screen=self._on_coding_session_screen,
            on_notice=self._on_coding_session_notice,
            on_finished=self._on_coding_session_finished,
        )

    def _publish_coding_session_reply(self, session: ManagedCodingSession, text: str) -> str:
        spoken = self.speech.speak(text)
        payload = {
            "text": spoken,
            "title": session.title,
            "intent": session.intent,
            "repo_path": session.repo_path,
        }
        self.events.publish(make_event("avatar.speaking", session.session_id, {"text": spoken}))
        self.events.publish(make_event("assistant.reply", session.session_id, payload))
        self.events.publish(make_event("agent.summary", session.session_id, payload))
        return spoken

    def _start_supervised_followup(self, repo_path: str, transcript: str) -> dict[str, Any]:
        effective_repo_path = self._preferred_followup_repo_path(repo_path)
        prompt = self._build_hermes_supervisor_prompt(
            repo_path=effective_repo_path,
            transcript=transcript,
        )
        try:
            result = self.hermes_runtime.prompt(effective_repo_path, prompt)
        except Exception as exc:
            message = f"Hermes could not supervise that request: {exc}"
            return self._respond(message)

        decision = self._extract_supervisor_decision(result.reply_text)
        if decision is None:
            reply = result.reply_text or "Hermes did not return a reply."
            self._record_hermes_turn(
                repo_path=effective_repo_path,
                title="Hermes supervisor",
                prompt=prompt,
                reply=reply,
                transport=result.transport,
            )
            return self._respond(reply)

        return self._execute_supervisor_decision(
            decision=decision,
            fallback_repo_path=effective_repo_path,
            prompt=prompt,
            transport=result.transport,
        )

    def _start_or_continue_hermes_partner_session(self, repo_path: str, transcript: str) -> dict[str, Any]:
        return self._start_generic_followup(repo_path, transcript)

    def _preferred_followup_repo_path(self, repo_path: str) -> str:
        requested_repo_path = self._resolve_requested_repo_path(repo_path)
        if requested_repo_path is not None:
            return requested_repo_path

        configured_focus = self._resolve_requested_repo_path(str(self.config.default_repo_path))
        if configured_focus is not None:
            return configured_focus

        last_session = self.store.last_completed()
        if last_session is not None:
            return last_session.repo_path
        return repo_path

    def _resolve_requested_repo_path(self, repo_path: str | None) -> str | None:
        if not isinstance(repo_path, str) or not repo_path.strip():
            return None
        return self._normalize_repo_path(repo_path)

    def _set_current_repo_focus(self, repo_path: str) -> None:
        normalized = self._normalize_repo_path(repo_path)
        if normalized is None:
            return
        self.config.default_repo_path = Path(normalized)
        if self._command_center is not None:
            self._command_center.state_store.set_current_project(normalized)

    def _can_use_visible_hermes_partner(self) -> bool:
        if Path(self.hermes.hermes_cmd).name != "hermes":
            return False
        return "open_hermes_cli" in self.coding_sessions.tools

    def _can_delegate_session_management_to_hermes(self) -> bool:
        return Path(self.hermes.hermes_cmd).name == "hermes" and self.control.bound_port is not None

    def _latest_open_coding_session(
        self,
        intent: str,
        repo_path: str | None = None,
    ) -> ManagedCodingSession | None:
        for session in self.coding_sessions.list_sessions():
            if session.intent != intent:
                continue
            if repo_path is not None and session.repo_path != repo_path:
                continue
            if session.status not in {SessionStatus.STARTING, SessionStatus.RUNNING}:
                continue
            return session
        return None

    def _latest_open_coding_session_for_repo(self, intent: str, repo_path: str) -> ManagedCodingSession | None:
        return self._latest_open_coding_session(intent, repo_path)

    def _build_hermes_supervisor_prompt(self, *, repo_path: str, transcript: str) -> str:
        snapshot = self._render_system_snapshot(repo_path)
        schema = json.dumps(
            {
                "action": "reply",
                "target": None,
                "repo_path": repo_path,
                "content": None,
                "reply_text": "Short truthful reply to the user.",
                "dangerously_skip_permissions": False,
            },
            indent=2,
        )
        return "\n".join(
            [
                "You are Hermes acting as the orchestration supervisor for the XR Coding Agent on the user's Mac.",
                "Your job is to decide the next controller action for Claude Code, Codex, Hermes CLI, or a direct user reply.",
                "Reply with JSON only. Do not wrap it in markdown.",
                "",
                "Allowed actions:",
                '- "reply": answer the user directly without touching a managed coding session.',
                '- "open_session": open a managed coding session.',
                '- "send_to_session": send exact text to an already open managed coding session.',
                '- "open_and_send_to_session": open a managed coding session, then send exact text to it.',
                '- "summarize_session": summarize an already open managed coding session.',
                '- "close_session": close an already open managed coding session.',
                "",
                "Allowed targets: open_claude_code, open_codex, open_hermes_cli, or null for reply.",
                "Use only repo paths that already appear in the snapshot or the current focus repo. Never invent or scan for new paths.",
                "Use send_to_session only when a suitable session already exists.",
                "Prefer short truthful reply_text values that describe the action you chose.",
                "",
                "JSON schema:",
                schema,
                "",
                "Authoritative system snapshot:",
                snapshot,
                "",
                f"Current focus repo: {repo_path}",
                f"User request: {transcript}",
            ]
        )

    def _extract_supervisor_decision(self, text: str) -> dict[str, Any] | None:
        payload = _extract_first_json_object(text)
        if not isinstance(payload, dict):
            return None

        action = payload.get("action")
        if not isinstance(action, str):
            return None
        normalized_action = action.strip().lower()
        if normalized_action not in {
            "reply",
            "open_session",
            "send_to_session",
            "open_and_send_to_session",
            "summarize_session",
            "close_session",
        }:
            return None

        target = self._normalize_supervisor_target(payload.get("target"))
        if normalized_action != "reply" and target is None:
            return None

        reply_text = payload.get("reply_text")
        content = payload.get("content")
        repo_path = payload.get("repo_path")
        dangerous_skip = payload.get("dangerously_skip_permissions") is True
        return {
            "action": normalized_action,
            "target": target,
            "repo_path": repo_path if isinstance(repo_path, str) else None,
            "content": content if isinstance(content, str) else None,
            "reply_text": reply_text if isinstance(reply_text, str) else None,
            "dangerously_skip_permissions": dangerous_skip,
        }

    def _normalize_supervisor_target(self, target: Any) -> str | None:
        if not isinstance(target, str):
            return None
        normalized = target.strip().lower()
        mapping = {
            "open_claude_code": "open_claude_code",
            "claude": "open_claude_code",
            "claude code": "open_claude_code",
            "open_codex": "open_codex",
            "codex": "open_codex",
            "codex cli": "open_codex",
            "open_hermes_cli": "open_hermes_cli",
            "hermes": "open_hermes_cli",
            "hermes cli": "open_hermes_cli",
        }
        return mapping.get(normalized)

    def _resolve_supervisor_repo_path(self, raw_repo_path: str | None, fallback_repo_path: str) -> str:
        if raw_repo_path:
            normalized = self._normalize_repo_path(raw_repo_path)
            if normalized is not None:
                return normalized
        return fallback_repo_path

    def _latest_coding_session_for_repo(self, intent: str, repo_path: str) -> ManagedCodingSession | None:
        for session in self.coding_sessions.list_sessions():
            if session.intent != intent:
                continue
            if session.repo_path != repo_path:
                continue
            return session
        return None

    def _execute_supervisor_decision(
        self,
        *,
        decision: dict[str, Any],
        fallback_repo_path: str,
        prompt: str,
        transport: str,
    ) -> dict[str, Any]:
        action = decision["action"]
        target = decision.get("target")
        repo_path = self._resolve_supervisor_repo_path(decision.get("repo_path"), fallback_repo_path)
        reply_text = decision.get("reply_text")
        content = decision.get("content")
        dangerously_skip_permissions = decision.get("dangerously_skip_permissions") is True

        if action == "reply":
            reply = reply_text or "Hermes did not choose a reply."
            self._record_hermes_turn(
                repo_path=repo_path,
                title="Hermes supervisor",
                prompt=prompt,
                reply=reply,
                transport=transport,
            )
            return self._respond(reply)

        if target is None:
            return self._respond("Hermes did not specify which managed session to use.")

        if action == "open_session":
            try:
                session = self._start_managed_coding_session(
                    target,
                    repo_path,
                    "",
                    requested_dangerous_skip=dangerously_skip_permissions,
                )
            except Exception as exc:
                return self._respond(f"Hermes could not open {self._tool_name_for_intent(target)}: {exc}")
            reply = reply_text or f"I opened {session.title} in {session.repo_path}."
            spoken = self._publish_coding_session_reply(session, reply)
            self._record_hermes_turn(
                repo_path=session.repo_path,
                title="Hermes supervisor",
                prompt=prompt,
                reply=spoken,
                transport=transport,
            )
            return {
                "message": spoken,
                "session_id": session.session_id,
                "intent": session.intent,
                "title": session.title,
                "repo_path": session.repo_path,
                "status": session.status.value,
                "pid": session.pid,
            }

        if action == "open_and_send_to_session":
            if not content:
                return self._respond("Hermes chose to open a session but did not provide anything to send.")
            try:
                session = self._start_managed_coding_session(
                    target,
                    repo_path,
                    "",
                    requested_dangerous_skip=dangerously_skip_permissions,
                )
                self._write_to_coding_session(session.session_id, content)
            except Exception as exc:
                return self._respond(f"Hermes could not start that coding worker: {exc}")
            reply = reply_text or f"I opened {session.title} and asked it to continue in {session.repo_path}."
            spoken = self._publish_coding_session_reply(session, reply)
            self._record_hermes_turn(
                repo_path=session.repo_path,
                title="Hermes supervisor",
                prompt=prompt,
                reply=spoken,
                transport=transport,
            )
            return {
                "message": spoken,
                "session_id": session.session_id,
                "intent": session.intent,
                "title": session.title,
                "repo_path": session.repo_path,
                "status": session.status.value,
                "pid": session.pid,
            }

        if action == "send_to_session":
            if not content:
                return self._respond("Hermes chose to send to a session but did not provide any content.")
            session = self._latest_open_coding_session(target, repo_path)
            if session is None:
                tool_name = self._tool_name_for_intent(target)
                return self._respond(f"No {tool_name} session is open in this project.")
            try:
                self._write_to_coding_session(session.session_id, content)
            except Exception as exc:
                return self._respond(f"Hermes could not send that to {session.title}: {exc}")
            reply = reply_text or f"I sent that to {session.title}."
            spoken = self._publish_coding_session_reply(session, reply)
            self._record_hermes_turn(
                repo_path=session.repo_path,
                title="Hermes supervisor",
                prompt=prompt,
                reply=spoken,
                transport=transport,
            )
            return {
                "message": spoken,
                "session_id": session.session_id,
                "intent": session.intent,
                "title": session.title,
                "repo_path": session.repo_path,
                "status": session.status.value,
                "pid": session.pid,
            }

        if action == "summarize_session":
            return self._summarize_coding_session(target, repo_path=repo_path)

        if action == "close_session":
            session = self._latest_open_coding_session(target, repo_path)
            if session is None:
                tool_name = self._tool_name_for_intent(target)
                return self._respond(f"No {tool_name} session is open in this project.")
            closed = self._close_coding_session_by_id(
                session.session_id,
                reply_text=reply_text or f"I closed {session.title}.",
            )
            self._record_hermes_turn(
                repo_path=closed.repo_path,
                title="Hermes supervisor",
                prompt=prompt,
                reply=reply_text or f"I closed {closed.title}.",
                transport=transport,
            )
            return {"message": reply_text or f"I closed {closed.title}.", "session_id": closed.session_id}

        return self._respond("Hermes chose an unsupported supervisor action.")

    def _send_to_coding_session(
        self,
        target: str | None,
        content: str | None,
        *,
        repo_path: str | None = None,
    ) -> dict[str, Any]:
        if target is None:
            return self._respond("Tell me whether to send that to Claude, Codex, or Hermes.")
        if not content:
            return self._respond("Tell me what you want me to send to that coding session.")

        session = self._latest_open_coding_session(target, repo_path)
        if session is None:
            tool_name = self._tool_name_for_intent(target)
            if repo_path is None:
                return self._respond(f"No {tool_name} session is open yet. Say 'open {tool_name.lower()} here' first.")
            return self._respond(f"No {tool_name} session is open in this project.")

        try:
            self._write_to_coding_session(session.session_id, content)
        except Exception as exc:
            return self._respond(f"Could not send that to {session.title}: {exc}")
        self._clear_pending_worker(
            session,
            status_text="Continuing",
            worker_phase="working",
            task_title=content,
            manager_summary=f"{self._ensure_worker_state(session).worker_label} is continuing with your update.",
            last_update=f"Direct input sent: {content}",
        )
        return self._respond(f"Sent that to {session.title}.")

    def _close_coding_session(self, target: str | None, *, repo_path: str | None = None) -> dict[str, Any]:
        if target is None:
            return self._respond("Tell me whether you want Claude, Codex, or Hermes closed.")

        session = self._latest_open_coding_session(target, repo_path)
        if session is None:
            tool_name = self._tool_name_for_intent(target)
            if repo_path is None:
                return self._respond(f"No {tool_name} session is open right now.")
            return self._respond(f"No {tool_name} session is open in this project.")

        try:
            closed = self._close_coding_session_by_id(session.session_id)
        except Exception as exc:
            return self._respond(f"Could not close {session.title}: {exc}")
        return {"message": f"Okay, closing {closed.title}.", "session_id": closed.session_id}

    def _close_coding_session_by_id(self, session_id: str, reply_text: str | None = None) -> ManagedCodingSession:
        session = self.coding_sessions.close_session(session_id)
        self._publish_coding_session_reply(session, reply_text or f"Okay, closing {session.title}.")
        return session

    def _publish_coding_session_snapshot(self) -> None:
        for session in reversed(self.coding_sessions.list_sessions()):
            self.events.publish(
                make_event(
                    "terminal.started",
                    session.session_id,
                    {
                        "title": session.title,
                        "repo_path": session.repo_path,
                        "command": session.command,
                        "pid": session.pid,
                        "log_path": session.log_path,
                        **self._worker_event_payload(session),
                    },
                )
            )
            if session.screen_text is not None:
                self.events.publish(
                    make_event(
                        "terminal.screen",
                        session.session_id,
                        {
                            "title": session.title,
                            "repo_path": session.repo_path,
                            "command": session.command,
                            "log_path": session.log_path,
                            "screen_text": session.screen_text,
                            "screen_rows": session.screen_rows,
                            "screen_columns": session.screen_columns,
                            **self._worker_event_payload(session),
                        },
                    )
                )
            for line in (session.output_tail or [])[-8:]:
                self.events.publish(
                    make_event(
                        "terminal.output",
                        session.session_id,
                        {
                            "title": session.title,
                            "line": line,
                            "repo_path": session.repo_path,
                            "log_path": session.log_path,
                            **self._worker_event_payload(session),
                        },
                    )
                )

    def _summarize_coding_session(self, target: str | None, *, repo_path: str | None = None) -> dict[str, Any]:
        if target is None:
            return self._respond("Tell me whether you want Claude, Codex, or Hermes summarized.")

        session = self._latest_open_coding_session(target, repo_path)
        if session is None:
            tool_name = self._tool_name_for_intent(target)
            if repo_path is None:
                return self._respond(f"No {tool_name} session is open yet.")
            return self._respond(f"No {tool_name} session is open in this project.")

        recent_output = "\n".join((session.output_tail or [])[-30:])
        if not recent_output.strip():
            return self._respond(f"{session.title} has not printed enough output yet for Hermes to summarize.")

        prompt = "\n".join(
            [
                "You are Hermes helping manage a coding session on my Mac.",
                f"Tool: {session.title}",
                f"Repo: {session.repo_path}",
                "Summarize what the tool is currently doing in 2 short sentences,",
                "and call out if it looks blocked or needs attention.",
                "",
                "Recent terminal output:",
                recent_output,
            ]
        )
        contextual_prompt = self._build_hermes_prompt(
            repo_path=session.repo_path,
            title=f"Hermes summary: {session.title}",
            prompt=prompt,
        )
        try:
            result = self.hermes_runtime.prompt(session.repo_path, contextual_prompt)
        except Exception as exc:
            detail = str(exc).strip()
            return self._respond(f"Hermes could not summarize {session.title}: {detail}")

        if not result.reply_text:
            reply = f"Hermes did not return a summary for {session.title}."
        else:
            reply = result.reply_text
        self._record_hermes_turn(
            repo_path=session.repo_path,
            title=f"Hermes summary: {session.title}",
            prompt=contextual_prompt,
            reply=reply,
            transport=result.transport,
        )
        return self._respond(reply)

    def _write_to_coding_session(self, session_id: str, text: str) -> None:
        session = self.coding_sessions.send_input(session_id, text)
        self.events.publish(
            make_event(
                "terminal.input",
                session_id,
                {
                    "title": session.title,
                    "text": text,
                    "repo_path": session.repo_path,
                },
            )
        )

    def _intent_for_tool_name(self, tool_name: str | None) -> str | None:
        if tool_name is None:
            return None
        normalized = tool_name.strip().lower()
        if normalized in {"claude", "claude code", "open_claude_code"}:
            return "open_claude_code"
        if normalized in {"codex", "codex cli", "open_codex"}:
            return "open_codex"
        if normalized in {"hermes", "hermes cli", "open_hermes_cli"}:
            return "open_hermes_cli"
        return None

    def _tool_name_for_intent(self, intent: str) -> str:
        names = {
            "open_claude_code": "Claude",
            "open_codex": "Codex",
            "open_hermes_cli": "Hermes",
        }
        return names.get(intent, intent)

    def _worker_prefix_for_intent(self, intent: str) -> str:
        names = {
            "open_claude_code": "Claude",
            "open_codex": "Codex",
            "open_hermes_cli": "Hermes",
        }
        return names.get(intent, "Worker")

    def _default_worker_task_title(self, session: ManagedCodingSession) -> str:
        return f"{self._tool_name_for_intent(session.intent)} task"

    def _decision_type_for_question(self, question: str) -> str:
        lowered = question.lower()
        if "review" in lowered:
            return "review"
        if any(marker in lowered for marker in ("fix", "apply", "ship", "merge", "continue", "proceed")):
            return "approval"
        return "input"

    def _format_manager_summary(self, state: WorkerSupervisorState) -> str:
        if state.waiting_on_user and state.pending_question:
            return f"{state.worker_label} is waiting on you: {state.pending_question}"
        if state.worker_phase == "blocked":
            return f"{state.worker_label} is blocked: {state.blocked_reason or state.status_text}"
        if state.worker_phase == "done":
            return f"{state.worker_label} finished: {state.last_update or state.status_text}"
        if state.worker_phase == "needs_review":
            return f"{state.worker_label} finished work and wants review."
        if state.worker_phase == "opening":
            return f"{state.worker_label} is opening in this project."
        if state.last_update:
            return f"{state.worker_label}: {state.last_update}"
        return f"{state.worker_label} is working on {state.task_title.lower()}."

    def _ensure_project_state(self, repo_path: str) -> ProjectSupervisorState:
        existing = self._project_states_by_repo_path.get(repo_path)
        if existing is not None:
            return existing
        state = ProjectSupervisorState(repo_path=repo_path)
        self._project_states_by_repo_path[repo_path] = state
        return state

    def _project_worker_states(self, repo_path: str, *, include_finished: bool = False) -> list[WorkerSupervisorState]:
        live_statuses = {SessionStatus.STARTING, SessionStatus.RUNNING}
        states: list[WorkerSupervisorState] = []
        for session in self.coding_sessions.list_sessions():
            if session.repo_path != repo_path:
                continue
            if not include_finished and session.status not in live_statuses:
                continue
            state = self._worker_state_for_session(session.session_id)
            if state is None:
                continue
            states.append(state)
        return states

    def _refresh_project_state(self, repo_path: str) -> ProjectSupervisorState:
        board = self._ensure_project_state(repo_path)
        workers = self._project_worker_states(repo_path)
        pending_states = [state for state in workers if state.waiting_on_user and state.pending_question]
        board.worker_session_ids = [state.session_id for state in workers]
        board.pending_session_ids = [state.session_id for state in pending_states]
        if pending_states:
            board.active_task_title = pending_states[0].task_title
            board.last_manager_summary = pending_states[0].manager_summary or self._format_manager_summary(pending_states[0])
        elif workers:
            board.active_task_title = workers[0].task_title
            board.last_manager_summary = workers[0].manager_summary or self._format_manager_summary(workers[0])
        else:
            board.active_task_title = None
            board.last_manager_summary = None
        return board

    def _ensure_worker_state(self, session: ManagedCodingSession) -> WorkerSupervisorState:
        existing = self._workers_by_session_id.get(session.session_id)
        if existing is not None:
            return existing

        worker_key = (session.repo_path, session.intent)
        next_index = self._worker_counts_by_intent.get(worker_key, 0) + 1
        self._worker_counts_by_intent[worker_key] = next_index
        state = WorkerSupervisorState(
            session_id=session.session_id,
            intent=session.intent,
            worker_label=f"{self._worker_prefix_for_intent(session.intent)} {next_index}",
            repo_path=session.repo_path,
            title=session.title,
            task_title=self._default_worker_task_title(session),
            worker_phase="opening" if session.status == SessionStatus.STARTING else "working",
            status_text="Opening…" if session.status == SessionStatus.STARTING else "Working",
        )
        self._workers_by_session_id[session.session_id] = state
        self._refresh_project_state(session.repo_path)
        return state

    def _worker_state_for_session(self, session_id: str) -> WorkerSupervisorState | None:
        return self._workers_by_session_id.get(session_id)

    def _running_worker_state_for_label(self, worker_label: str, *, repo_path: str) -> tuple[WorkerSupervisorState, ManagedCodingSession] | None:
        normalized_label = " ".join(worker_label.lower().split())
        for session in self.coding_sessions.list_sessions():
            if session.status not in {SessionStatus.STARTING, SessionStatus.RUNNING}:
                continue
            if session.repo_path != repo_path:
                continue
            state = self._worker_state_for_session(session.session_id)
            if state is None:
                continue
            if " ".join(state.worker_label.lower().split()) == normalized_label:
                return state, session
        return None

    def _extract_explicit_worker_instruction(self, transcript: str) -> tuple[str, str] | None:
        normalized = " ".join(transcript.strip().split())
        if not normalized:
            return None

        worker_match = re.search(r"\b(claude|codex|hermes)(?:\s+(?:session|worker))?\s+(\d+)\b", normalized, flags=re.IGNORECASE)
        if worker_match is None:
            return None

        worker_label = f"{worker_match.group(1).title()} {worker_match.group(2)}"
        content_match = re.search(r"\btell\s+(?:them|him|her)\s+to\s+(.+)$", normalized, flags=re.IGNORECASE)
        if content_match is None:
            content_match = re.search(
                r"\b(?:tell|ask|have)\s+"
                + re.escape(worker_match.group(0))
                + r"\s+to\s+(.+)$",
                normalized,
                flags=re.IGNORECASE,
            )
        if content_match is None:
            return None

        content = content_match.group(1).strip().rstrip("?.!")
        if not content:
            return None
        return worker_label, content

    def _handle_explicit_worker_instruction(self, transcript: str, *, repo_path: str) -> dict[str, Any] | None:
        extracted = self._extract_explicit_worker_instruction(transcript)
        if extracted is None:
            return None

        worker_label, content = extracted
        resolved = self._running_worker_state_for_label(worker_label, repo_path=repo_path)
        if resolved is None:
            return self._respond(f"I could not find a live {worker_label} session in this project.")

        state, session = resolved
        try:
            self._write_to_coding_session(session.session_id, content)
        except Exception as exc:
            return self._respond(f"Could not send that to {state.worker_label}: {exc}")

        self._clear_pending_worker(
            session,
            status_text="Continuing",
            worker_phase="working",
            task_title=content,
            manager_summary=f"{state.worker_label} is continuing with your instruction.",
            last_update=f"User instructed {state.worker_label}: {content}",
        )
        reply = f"I told {state.worker_label} to {content}."
        self.events.publish(
            make_event(
                "hermes.status",
                session.session_id,
                {
                    "text": reply,
                    "worker_label": state.worker_label,
                    "repo_path": session.repo_path,
                    "title": session.title,
                    "intent": session.intent,
                },
            )
        )
        return self._respond(reply)

    def _update_worker_state(
        self,
        session: ManagedCodingSession,
        *,
        status_text: str | None = None,
        task_title: str | None = None,
        worker_phase: str | None = None,
        manager_summary: str | None = None,
        waiting_on_user: bool | None = None,
        needs_review: bool | None = None,
        blocked_reason: str | None = None,
        pending_question: str | None = None,
        last_update: str | None = None,
    ) -> WorkerSupervisorState:
        state = self._ensure_worker_state(session)
        updated = WorkerSupervisorState(
            session_id=state.session_id,
            intent=state.intent,
            worker_label=state.worker_label,
            repo_path=session.repo_path,
            title=session.title,
            task_title=task_title or state.task_title,
            worker_phase=worker_phase or state.worker_phase,
            status_text=status_text or state.status_text,
            manager_summary=manager_summary if manager_summary is not None else state.manager_summary,
            waiting_on_user=waiting_on_user if waiting_on_user is not None else state.waiting_on_user,
            needs_review=needs_review if needs_review is not None else state.needs_review,
            blocked_reason=blocked_reason if blocked_reason is not None else state.blocked_reason,
            pending_question=pending_question if pending_question is not None else state.pending_question,
            last_update=last_update if last_update is not None else state.last_update,
        )
        if not updated.manager_summary:
            updated.manager_summary = self._format_manager_summary(updated)
        self._workers_by_session_id[session.session_id] = updated
        self._refresh_project_state(session.repo_path)
        return updated

    def _worker_event_payload(self, session: ManagedCodingSession) -> dict[str, Any]:
        state = self._worker_state_for_session(session.session_id)
        payload: dict[str, Any] = {}
        if state is None:
            return payload
        payload["worker_label"] = state.worker_label
        payload["status_text"] = state.status_text
        payload["task_title"] = state.task_title
        payload["worker_phase"] = state.worker_phase
        payload["waiting_on_user"] = state.waiting_on_user
        payload["needs_review"] = state.needs_review
        payload["manager_summary"] = state.manager_summary or self._format_manager_summary(state)
        if state.blocked_reason:
            payload["blocked_reason"] = state.blocked_reason
        if state.pending_question:
            payload["pending_question"] = state.pending_question
        if state.last_update:
            payload["last_update"] = state.last_update
        return payload

    def _publish_worker_update(self, session: ManagedCodingSession) -> None:
        state = self._ensure_worker_state(session)
        self.events.publish(
            make_event(
                "worker.updated",
                session.session_id,
                {
                    "worker_label": state.worker_label,
                    "status_text": state.status_text,
                    "repo_path": session.repo_path,
                    "title": session.title,
                    "intent": session.intent,
                    "task_title": state.task_title,
                    "worker_phase": state.worker_phase,
                    "waiting_on_user": state.waiting_on_user,
                    "needs_review": state.needs_review,
                    "manager_summary": state.manager_summary or self._format_manager_summary(state),
                    "blocked_reason": state.blocked_reason or "",
                    "pending_question": state.pending_question or "",
                    "last_update": state.last_update or "",
                },
            )
        )

    def _mark_worker_pending(self, session: ManagedCodingSession, question: str) -> None:
        cleaned_question = question.strip()
        if not cleaned_question:
            return
        decision_type = self._decision_type_for_question(cleaned_question)
        state = self._update_worker_state(
            session,
            status_text="Waiting on you",
            worker_phase="waiting_on_user",
            manager_summary=f"{self._ensure_worker_state(session).worker_label} needs your decision.",
            waiting_on_user=True,
            needs_review=decision_type == "review",
            blocked_reason="",
            pending_question=cleaned_question,
            last_update=cleaned_question,
        )
        self._pending_decisions_by_session_id[session.session_id] = PendingDecisionRecord(
            session_id=session.session_id,
            repo_path=session.repo_path,
            worker_label=state.worker_label,
            question=cleaned_question,
            decision_type=decision_type,
        )
        payload = {
            "worker_label": state.worker_label,
            "question": cleaned_question,
            "decision_type": decision_type,
            "repo_path": session.repo_path,
            "title": session.title,
            "intent": session.intent,
            **self._worker_event_payload(session),
        }
        self.events.publish(make_event("worker.pending_question", session.session_id, payload))
        self.events.publish(
            make_event(
                "hermes.status",
                session.session_id,
                {"text": f"{state.worker_label} asked: {cleaned_question}", **payload},
            )
        )
        self._publish_worker_update(session)

    def _clear_pending_worker(
        self,
        session: ManagedCodingSession,
        *,
        status_text: str,
        worker_phase: str = "working",
        task_title: str | None = None,
        manager_summary: str | None = None,
        last_update: str | None = None,
    ) -> None:
        self._update_worker_state(
            session,
            status_text=status_text,
            task_title=task_title,
            worker_phase=worker_phase,
            manager_summary=manager_summary,
            waiting_on_user=False,
            needs_review=False,
            blocked_reason="",
            pending_question="",
            last_update=last_update or status_text,
        )
        self._pending_decisions_by_session_id.pop(session.session_id, None)
        self._publish_worker_update(session)

    def _has_pending_worker_question(self, *, repo_path: str) -> bool:
        return bool(self._pending_worker_states(repo_path=repo_path))

    def _pending_worker_states(self, *, repo_path: str) -> list[WorkerSupervisorState]:
        resolved: list[tuple[datetime, WorkerSupervisorState]] = []
        for decision in self._pending_decisions_by_session_id.values():
            if decision.repo_path != repo_path:
                continue
            state = self._workers_by_session_id.get(decision.session_id)
            if state is None or not state.pending_question or not state.waiting_on_user:
                continue
            session = self.coding_sessions.get(decision.session_id)
            if session is None or session.status not in {SessionStatus.STARTING, SessionStatus.RUNNING}:
                continue
            resolved.append((decision.created_at, state))
        resolved.sort(key=lambda item: item[0], reverse=True)
        return [state for _, state in resolved]

    def _pending_worker_state(self, *, repo_path: str) -> WorkerSupervisorState | None:
        states = self._pending_worker_states(repo_path=repo_path)
        return states[0] if states else None

    def _matches_pending_reply_marker(self, transcript: str, markers: tuple[str, ...]) -> bool:
        normalized = " ".join(transcript.lower().split())
        return any(re.search(rf"(?<!\w){re.escape(marker)}(?!\w)", normalized) for marker in markers)

    def _looks_like_pending_worker_reply(self, transcript: str) -> bool:
        reply_markers = (
            "yes",
            "yeah",
            "yep",
            "okay",
            "ok",
            "approve",
            "go ahead",
            "do it",
            "fix it",
            "let them",
            "let him",
            "let her",
            "continue",
            "proceed",
            "review it",
            "review that",
            "ship it",
            "no",
            "not yet",
            "hold off",
            "don't",
            "do not",
            "stop",
            "skip it",
        )
        return self._matches_pending_reply_marker(transcript, reply_markers)

    def _normalize_pending_worker_reply(self, transcript: str) -> str:
        if self._matches_pending_reply_marker(
            transcript,
            ("yes", "yeah", "yep", "ok", "okay", "approve", "go ahead", "proceed", "do it", "fix it", "let them"),
        ):
            return "The user approved it. Go ahead and continue, then report back with what changed."
        if self._matches_pending_reply_marker(transcript, ("review it", "review that")):
            return "The user wants you to review it now and then summarize the important findings."
        if self._matches_pending_reply_marker(transcript, ("no", "not yet", "hold off", "don't", "do not", "stop", "skip it")):
            return "The user said no for now. Hold off, keep the current work intact, and explain the next best option."
        return transcript.strip()

    def _reply_to_pending_worker(self, transcript: str, *, repo_path: str) -> dict[str, Any]:
        state = self._pending_worker_state(repo_path=repo_path)
        if state is None:
            return self._start_generic_followup(repo_path, transcript)

        session = self.coding_sessions.get(state.session_id)
        if session is None:
            return self._start_generic_followup(repo_path, transcript)

        outbound = self._normalize_pending_worker_reply(transcript)
        try:
            self._write_to_coding_session(session.session_id, outbound)
        except Exception as exc:
            return self._respond(f"Could not send that to {state.worker_label}: {exc}")

        self._clear_pending_worker(
            session,
            status_text="Continuing",
            worker_phase="working",
            manager_summary=f"{state.worker_label} is continuing with your approval.",
            last_update=f"User replied: {transcript.strip()}",
        )
        reply = f"I told {state.worker_label} to continue."
        self.events.publish(
            make_event(
                "hermes.status",
                session.session_id,
                {
                    "text": reply,
                    "worker_label": state.worker_label,
                    "repo_path": session.repo_path,
                    "title": session.title,
                    "intent": session.intent,
                },
            )
        )
        return self._respond(reply)

    def _handle_worker_reply_message(
        self,
        *,
        session_id: str,
        text: str,
        route_via_manager: bool,
    ) -> None:
        session = self.coding_sessions.get(session_id)
        if session is None:
            raise RuntimeError(f"No managed coding session found for {session_id}.")

        cleaned_text = text.strip()
        if not cleaned_text:
            raise RuntimeError("Worker replies need text.")

        if route_via_manager:
            if not self._reply_to_targeted_pending_worker(session, cleaned_text):
                state = self._worker_state_for_session(session.session_id)
                worker_label = state.worker_label if state is not None else session.title
                raise RuntimeError(f"{worker_label} is not currently waiting on a manager-routed reply.")
            return

        self._write_to_coding_session(session.session_id, cleaned_text)

    def _reply_to_targeted_pending_worker(self, session: ManagedCodingSession, transcript: str) -> bool:
        state = self._worker_state_for_session(session.session_id)
        if state is None or not state.waiting_on_user or not state.pending_question:
            return False

        outbound = self._normalize_pending_worker_reply(transcript)
        self._write_to_coding_session(session.session_id, outbound)
        reply = self._targeted_worker_reply_status_text(state.worker_label, transcript)
        status_text, manager_summary = self._targeted_worker_reply_state(state.worker_label, transcript)
        self._clear_pending_worker(
            session,
            status_text=status_text,
            worker_phase="working",
            manager_summary=manager_summary,
            last_update=f"User replied: {transcript.strip()}",
        )
        self.events.publish(
            make_event(
                "hermes.status",
                session.session_id,
                {
                    "text": reply,
                    "worker_label": state.worker_label,
                    "repo_path": session.repo_path,
                    "title": session.title,
                    "intent": session.intent,
                },
            )
        )
        self.events.publish(make_event("assistant.reply", session.session_id, {"text": reply}))
        self.events.publish(make_event("agent.summary", session.session_id, {"text": reply}))
        return True

    def _resolve_pending_worker_after_direct_input(self, session_id: str, text: str) -> None:
        state = self._worker_state_for_session(session_id)
        if state is None or not state.waiting_on_user or not state.pending_question:
            return

        session = self.coding_sessions.get(session_id)
        if session is None:
            return

        self._clear_pending_worker(
            session,
            status_text="Continuing",
            worker_phase="working",
            manager_summary=f"{state.worker_label} is continuing with your direct reply.",
            last_update=f"User replied directly: {text.strip()}",
        )
        self.events.publish(
            make_event(
                "hermes.status",
                session.session_id,
                {
                    "text": f"{state.worker_label} received your direct reply.",
                    "worker_label": state.worker_label,
                    "repo_path": session.repo_path,
                    "title": session.title,
                    "intent": session.intent,
                },
            )
        )

    def _targeted_worker_reply_status_text(self, worker_label: str, transcript: str) -> str:
        normalized = " ".join(transcript.lower().split())
        if self._matches_pending_reply_marker(
            normalized,
            ("yes", "yeah", "yep", "ok", "okay", "approve", "go ahead", "proceed", "do it", "fix it", "let them"),
        ):
            return f"I told {worker_label} to continue."
        if self._matches_pending_reply_marker(normalized, ("review it", "review that")):
            return f"I told {worker_label} to review it now."
        if self._matches_pending_reply_marker(
            normalized,
            ("no", "not yet", "hold off", "don't", "do not", "stop", "skip it"),
        ):
            return f"I told {worker_label} to hold off for now."
        return f"I sent your reply to {worker_label}."

    def _targeted_worker_reply_state(self, worker_label: str, transcript: str) -> tuple[str, str]:
        normalized = " ".join(transcript.lower().split())
        if self._matches_pending_reply_marker(
            normalized,
            ("yes", "yeah", "yep", "ok", "okay", "approve", "go ahead", "proceed", "do it", "fix it", "let them"),
        ):
            return "Continuing", f"{worker_label} is continuing with your approval."
        if self._matches_pending_reply_marker(normalized, ("review it", "review that")):
            return "Reviewing", f"{worker_label} is reviewing now."
        if self._matches_pending_reply_marker(
            normalized,
            ("no", "not yet", "hold off", "don't", "do not", "stop", "skip it"),
        ):
            return "Holding off", f"{worker_label} is holding off for now."
        return "Continuing", f"{worker_label} is continuing with your update."

    def _extract_worker_question(self, line: str) -> str | None:
        cleaned = " ".join(line.strip().split())
        if not cleaned or "?" not in cleaned:
            return None

        lowered = cleaned.lower()
        question_markers = (
            "do you want me to",
            "would you like me to",
            "should i",
            "should we",
            "can i",
            "may i",
            "want me to",
            "approve",
            "review",
            "fix it",
            "fix this",
        )
        if not any(marker in lowered for marker in question_markers):
            return None
        return cleaned

    def _worker_blocked_reason_from_line(self, line: str) -> str | None:
        cleaned = " ".join(line.strip().split())
        lowered = cleaned.lower()
        blocked_markers = (
            "please run /login",
            "oauth token has expired",
            "permission denied",
            "authentication failed",
            "not authorized",
            "error:",
            "fatal:",
            "failed:",
        )
        if any(marker in lowered for marker in blocked_markers):
            return cleaned
        return None

    def _looks_like_worker_progress(self, line: str) -> bool:
        lowered = " ".join(line.strip().lower().split())
        progress_markers = (
            "reviewing",
            "inspecting",
            "running",
            "editing",
            "updating",
            "checking",
            "thinking",
            "working",
            "analyzing",
            "reading",
        )
        return any(marker in lowered for marker in progress_markers)

    def _resolve_control_session(
        self,
        *,
        tool_name: str | None,
        session_id: str | None,
        repo_path: str | None,
    ) -> ManagedCodingSession:
        if session_id is not None:
            session = self.coding_sessions.get(session_id)
            if session is None:
                raise KeyError(f"No managed coding session found for {session_id}")
            return session

        intent = self._intent_for_tool_name(tool_name)
        if intent is None:
            raise ValueError("Specify session_id or tool=claude|codex|hermes.")

        resolved_repo_path = str(Path(repo_path).expanduser().resolve()) if repo_path else None
        session = self._latest_open_coding_session(intent, resolved_repo_path)
        if session is None:
            tool_label = self._tool_name_for_intent(intent)
            if resolved_repo_path is None:
                raise RuntimeError(f"No running {tool_label} session is open.")
            raise RuntimeError(f"No running {tool_label} session is open in {resolved_repo_path}.")
        return session

    def _control_session_payload(self, session: ManagedCodingSession) -> dict[str, Any]:
        return {
            "session_id": session.session_id,
            "intent": session.intent,
            "title": session.title,
            "repo_path": session.repo_path,
            "command": session.command,
            "status": session.status.value,
            "pid": session.pid,
            "exit_code": session.exit_code,
            "summary": session.summary,
            "log_path": session.log_path,
            "screen_text": session.screen_text,
            "screen_rows": session.screen_rows,
            "screen_columns": session.screen_columns,
            "output_tail": list(session.output_tail or []),
            **self._worker_event_payload(session),
        }

    def _resolve_repo_path_from_transcript(self, default_repo_path: str, transcript: str) -> tuple[str, str]:
        spoken_path = self._extract_spoken_repo_path(transcript)
        if spoken_path is not None:
            resolved_path = self._normalize_repo_path(spoken_path)
            if resolved_path is not None:
                cleaned_transcript = transcript.replace(spoken_path, "this project", 1)
                cleaned_transcript = re.sub(r"\s+", " ", cleaned_transcript).strip(" ,.-")
                return resolved_path, cleaned_transcript or transcript

        named_project_path = self._resolve_named_project_path(transcript, default_repo_path)
        if named_project_path is not None:
            return named_project_path, transcript

        return default_repo_path, transcript

    def _extract_spoken_repo_path(self, transcript: str) -> str | None:
        patterns = [
            r"(?:go to|open|launch|start|in|at)\s+(?P<path>~(?:/[^,;]+?)?|/(?:[^,;]+?)|\.\.?/(?:[^,;]+?))(?=\s+(?:and|then)\b|$)",
            r"(?:project|repo|repository)\s+(?:at|in)\s+(?P<path>~(?:/[^,;]+?)?|/(?:[^,;]+?)|\.\.?/(?:[^,;]+?))(?=\s+(?:and|then)\b|$)",
        ]
        for pattern in patterns:
            match = re.search(pattern, transcript, flags=re.IGNORECASE)
            if match:
                return match.group("path").strip().strip("\"'")
        return None

    def _normalize_repo_path(self, raw_path: str) -> str | None:
        try:
            candidate = Path(raw_path).expanduser()
            if not candidate.is_absolute():
                candidate = (Path.cwd() / candidate).resolve()
            else:
                candidate = candidate.resolve()
        except OSError:
            return None

        if candidate.is_file():
            candidate = candidate.parent
        if not candidate.exists() or not candidate.is_dir():
            return None
        return str(candidate)

    def _resolve_named_project_path(self, transcript: str, default_repo_path: str) -> str | None:
        normalized_transcript = self._normalize_project_phrase(transcript)
        if not normalized_transcript:
            return None

        best_match: tuple[int, str] | None = None
        for candidate in self._candidate_project_paths(default_repo_path):
            aliases = self._project_aliases(candidate)
            for alias in aliases:
                if not alias or alias not in normalized_transcript:
                    continue

                score = len(alias.split()) * 10 + len(alias)
                if f"{alias} project" in normalized_transcript:
                    score += 20
                if f"{alias} repo" in normalized_transcript or f"{alias} repository" in normalized_transcript:
                    score += 20
                if f"{alias} folder" in normalized_transcript:
                    score += 15
                if best_match is None or score > best_match[0]:
                    best_match = (score, candidate)

        return best_match[1] if best_match is not None else None

    def _candidate_project_paths(self, default_repo_path: str) -> list[str]:
        roots: list[Path] = []
        seen_roots: set[Path] = set()

        def add_root(path: Path) -> None:
            resolved = path.expanduser().resolve()
            if resolved in seen_roots or not resolved.exists() or not resolved.is_dir():
                return
            seen_roots.add(resolved)
            roots.append(resolved)

        default_path = Path(default_repo_path).expanduser().resolve()
        add_root(default_path)
        for ancestor in list(default_path.parents)[:3]:
            add_root(ancestor)

        desktop_root = Path.home() / "Desktop"
        if desktop_root.exists():
            add_root(desktop_root)

        for configured_root in self.config.project_search_roots:
            add_root(configured_root)

        ignore_names = {
            ".git",
            ".venv",
            "venv",
            "node_modules",
            "__pycache__",
            "DerivedData",
            ".pytest_cache",
            ".mypy_cache",
        }
        project_markers = {
            ".git",
            "package.json",
            "pyproject.toml",
            "Cargo.toml",
            "go.mod",
            "requirements.txt",
            "Makefile",
        }

        candidates: list[str] = []
        seen_candidates: set[Path] = set()

        for root in roots:
            stack: list[tuple[Path, int]] = [(root, 0)]
            while stack:
                path, depth = stack.pop()
                if path in seen_candidates:
                    continue

                try:
                    entries = list(path.iterdir())
                except OSError:
                    continue

                is_project = False
                for marker in project_markers:
                    try:
                        if (path / marker).exists():
                            is_project = True
                            break
                    except OSError:
                        continue
                if not is_project:
                    for entry in entries:
                        try:
                            if entry.suffix in {".xcodeproj", ".xcworkspace"}:
                                is_project = True
                                break
                        except OSError:
                            continue
                if path == default_path or is_project:
                    seen_candidates.add(path)
                    candidates.append(str(path))

                if depth >= 4:
                    continue

                for entry in entries:
                    try:
                        is_dir = entry.is_dir()
                    except OSError:
                        continue
                    if not is_dir:
                        continue
                    if entry.name.startswith(".") and entry.name not in {".config"}:
                        continue
                    if entry.name in ignore_names:
                        continue
                    stack.append((entry, depth + 1))

        return candidates

    def _project_aliases(self, raw_path: str) -> set[str]:
        path = Path(raw_path)
        aliases: set[str] = set()
        parts = [self._normalize_project_phrase(part) for part in path.parts if part not in {path.anchor, ""}]
        parts = [part for part in parts if part]

        name_alias = self._normalize_project_phrase(path.name)
        if name_alias:
            aliases.add(name_alias)

        for count in range(2, min(4, len(parts)) + 1):
            alias = " ".join(parts[-count:])
            if alias:
                aliases.add(alias)

        return aliases

    def _normalize_project_phrase(self, value: str) -> str:
        normalized = value.lower()
        normalized = normalized.replace("-", " ").replace("_", " ")
        normalized = re.sub(r"[^a-z0-9]+", " ", normalized)
        return re.sub(r"\s+", " ", normalized).strip()

    def _coding_session_extra_args(
        self,
        intent: str,
        transcript: str,
        *,
        requested_dangerous_skip: bool = False,
    ) -> list[str]:
        lowered = transcript.lower()
        wants_dangerous_skip = requested_dangerous_skip or any(
            phrase in lowered
            for phrase in (
                "dangerously skip permissions",
                "dangerously-skip-permissions",
                "dangerous skip permissions",
                "skip permissions",
            )
        )
        if not wants_dangerous_skip:
            return []

        if intent == "open_claude_code":
            return ["--dangerously-skip-permissions"]
        if intent == "open_codex":
            return ["--dangerously-bypass-approvals-and-sandbox"]
        return []

    def _on_session_started(self, session: Session) -> None:
        self.events.publish(
            make_event(
                "session.started",
                session.session_id,
                {
                    "title": session.title,
                    "repo_path": session.repo_path,
                    "command": session.command,
                    "pid": session.pid,
                },
            )
        )

    def _on_session_output(self, session: Session, line: str) -> None:
        if _should_skip_output_event(line):
            return
        self.events.publish(make_event("session.output", session.session_id, {"line": line}))

    def _on_session_finished(self, session: Session) -> None:
        summary = self._user_facing_summary(session)
        updated = Session(
            session_id=session.session_id,
            title=session.title,
            repo_path=session.repo_path,
            command=session.command,
            status=session.status,
            started_at=session.started_at,
            finished_at=session.finished_at,
            exit_code=session.exit_code,
            pid=session.pid,
            output_tail=session.output_tail,
            summary=summary,
        )
        self.store.update(updated)
        event_type = "session.finished" if updated.exit_code == 0 else "session.failed"
        self.events.publish(
            make_event(
                event_type,
                updated.session_id,
                {
                    "title": updated.title,
                    "exit_code": updated.exit_code,
                    "summary": summary,
                },
            )
        )
        self.events.publish(make_event("assistant.reply", updated.session_id, {"text": summary}))
        self.events.publish(make_event("agent.summary", updated.session_id, {"text": summary}))

    def _user_facing_summary(self, session: Session) -> str:
        if self.hermes.is_hermes_command(session.command):
            hermes_reply = self.hermes.extract_assistant_reply("\n".join(session.output_tail))
            if hermes_reply:
                return hermes_reply
        if session.summary:
            return session.summary
        return self.summarizer.summarize(session)

    def _on_coding_session_started(self, session: ManagedCodingSession) -> None:
        self._update_worker_state(
            session,
            status_text="Opening…",
            worker_phase="opening",
            manager_summary=f"{self._ensure_worker_state(session).worker_label} is opening in this project.",
            last_update="Worker opened",
        )
        self.events.publish(
            make_event(
                "terminal.started",
                session.session_id,
                {
                    "title": session.title,
                    "repo_path": session.repo_path,
                    "command": session.command,
                    "pid": session.pid,
                    "log_path": session.log_path,
                    **self._worker_event_payload(session),
                },
            )
        )
        self._publish_worker_update(session)

    def _on_coding_session_output(self, session: ManagedCodingSession, line: str) -> None:
        blocked_reason = self._worker_blocked_reason_from_line(line)
        if blocked_reason is not None:
            self._update_worker_state(
                session,
                status_text="Blocked",
                worker_phase="blocked",
                manager_summary=f"{self._ensure_worker_state(session).worker_label} is blocked and needs attention.",
                blocked_reason=blocked_reason,
                waiting_on_user=False,
                last_update=blocked_reason,
            )
        elif self._looks_like_worker_progress(line):
            state = self._ensure_worker_state(session)
            self._update_worker_state(
                session,
                status_text="Working",
                worker_phase="working",
                manager_summary=f"{state.worker_label} is making progress.",
                blocked_reason="",
                waiting_on_user=False,
                last_update=" ".join(line.strip().split()),
            )
        question = self._extract_worker_question(line)
        if question is not None:
            state = self._worker_state_for_session(session.session_id)
            if state is None or state.pending_question != question:
                self._mark_worker_pending(session, question)
        self.events.publish(
            make_event(
                "terminal.output",
                session.session_id,
                {
                    "title": session.title,
                    "line": line,
                    "repo_path": session.repo_path,
                    "log_path": session.log_path,
                    **self._worker_event_payload(session),
                },
            )
        )

    def _on_coding_session_screen(self, session: ManagedCodingSession) -> None:
        self.events.publish(
            make_event(
                "terminal.screen",
                session.session_id,
                {
                    "title": session.title,
                    "repo_path": session.repo_path,
                    "command": session.command,
                    "log_path": session.log_path,
                    "screen_text": session.screen_text,
                    "screen_rows": session.screen_rows,
                    "screen_columns": session.screen_columns,
                    **self._worker_event_payload(session),
                },
            )
        )

    def _on_coding_session_finished(self, session: ManagedCodingSession) -> None:
        self._update_worker_state(
            session,
            status_text="Done" if session.exit_code == 0 else "Failed",
            worker_phase="done" if session.exit_code == 0 else "blocked",
            manager_summary=(
                f"{self._ensure_worker_state(session).worker_label} finished and is ready with an update."
                if session.exit_code == 0
                else f"{self._ensure_worker_state(session).worker_label} failed before finishing."
            ),
            waiting_on_user=False,
            needs_review=False,
            blocked_reason="" if session.exit_code == 0 else (session.summary or f"{session.title} exited."),
            pending_question="",
            last_update=session.summary or f"{session.title} exited.",
        )
        self._pending_decisions_by_session_id.pop(session.session_id, None)
        event_type = "terminal.finished" if session.exit_code == 0 else "terminal.failed"
        self.events.publish(
            make_event(
                event_type,
                session.session_id,
                {
                    "title": session.title,
                    "summary": session.summary or f"{session.title} exited.",
                    "exit_code": session.exit_code,
                    "repo_path": session.repo_path,
                    "log_path": session.log_path,
                    **self._worker_event_payload(session),
                },
            )
        )
        self._publish_worker_update(session)

    def _on_coding_session_notice(self, session: ManagedCodingSession, text: str) -> None:
        self._update_worker_state(
            session,
            status_text="Working",
            worker_phase="working",
            manager_summary=f"{self._ensure_worker_state(session).worker_label} is progressing.",
            blocked_reason="",
            waiting_on_user=False,
            last_update=text,
        )
        payload = {
            "text": text,
            "title": session.title,
            "repo_path": session.repo_path,
            **self._worker_event_payload(session),
        }
        self.events.publish(make_event("hermes.status", session.session_id, payload))
        self.events.publish(make_event("agent.summary", session.session_id, payload))
        self._publish_worker_update(session)

    def _ask_hermes(self, repo_path: str, title: str, prompt: str) -> dict[str, Any]:
        started_at = datetime.now()
        contextual_prompt = self._build_hermes_prompt(
            repo_path=repo_path,
            title=title,
            prompt=prompt,
        )
        try:
            result = self.hermes_runtime.prompt(repo_path, contextual_prompt)
        except Exception as exc:
            message = f"Hermes could not finish that request: {exc}"
            self._record_hermes_failure(
                repo_path=repo_path,
                title=title,
                prompt=contextual_prompt,
                summary=message,
                started_at=started_at,
            )
            return self._respond(message)

        reply = result.reply_text or "Hermes did not return a reply."
        self._record_hermes_turn(
            repo_path=repo_path,
            title=title,
            prompt=contextual_prompt,
            reply=reply,
            transport=result.transport,
            started_at=started_at,
        )
        return self._respond(reply)

    def _build_hermes_prompt(self, *, repo_path: str, title: str, prompt: str) -> str:
        snapshot = self._render_system_snapshot(repo_path)
        return "\n".join(
            [
                "You are Hermes embedded inside the XR Coding Agent on the user's Mac.",
                "The authoritative system snapshot below is your source of truth for projects, terminals, and tool sessions.",
                "Use the xr_managed_session tool when you need to inspect or control managed Claude Code, Codex, or Hermes CLI sessions.",
                "That tool can list sessions, open a worker, send input, read the live screen, and close a worker.",
                "When the user refers to ongoing Claude or Codex work vaguely, inspect current managed sessions before asking for clarification.",
                "Never claim you opened, closed, switched, or sent input to Claude, Codex, or Hermes unless the tool result or the snapshot confirms it.",
                "",
                "Authoritative system snapshot:",
                snapshot,
                "",
                f"Current focus repo: {repo_path}",
                f"Request title: {title}",
                "",
                "Hermes task:",
                prompt,
            ]
        )

    def _build_visible_hermes_partner_prompt(self, *, repo_path: str, transcript: str) -> str:
        return "\n".join(
            [
                "You are Hermes, the user's coding partner inside XR Coding Agent.",
                f"Current repo: {repo_path}",
                "Use xr_managed_session when you need to inspect or control Claude Code, Codex, or Hermes CLI sessions.",
                "Keep updates concise and natural. Handle safe Claude trust or confirm prompts when they appear, keep the user posted briefly, and tell the user when the worker is done.",
                f"User request: {transcript}",
            ]
        )

    def _render_system_snapshot(self, repo_path: str) -> str:
        lines = [
            f"- default repo focus: {repo_path}",
            "- managed coding sessions:",
        ]

        coding_sessions = self.coding_sessions.list_sessions()
        if coding_sessions:
            for session in coding_sessions[:6]:
                worker = self._worker_state_for_session(session.session_id)
                detail = (
                    f"  - {session.title} [{session.intent}] id={session.session_id} "
                    f"status={session.status.value} repo={session.repo_path}"
                )
                if worker is not None:
                    detail += f" worker={worker.worker_label} worker_status={worker.status_text}"
                    if worker.pending_question:
                        detail += f" pending_question={self._truncate_snapshot_line(worker.pending_question, 90)}"
                if session.output_tail:
                    detail += f" last_output={self._truncate_snapshot_line(session.output_tail[-1])}"
                lines.append(detail)
        else:
            lines.append("  - none")

        active_sessions = self.store.list_active()
        lines.append("- tracked task sessions:")
        if active_sessions:
            for session in active_sessions[:5]:
                lines.append(
                    f"  - {session.title} id={session.session_id} status={session.status.value} repo={session.repo_path}"
                )
        else:
            lines.append("  - none")

        recent_completed = self.store.completed_sessions()[:4]
        lines.append("- recent completed work:")
        if recent_completed:
            for session in recent_completed:
                detail = (
                    f"  - {session.title} id={session.session_id} "
                    f"status={session.status.value} repo={session.repo_path}"
                )
                if session.summary:
                    detail += f" summary={self._truncate_snapshot_line(session.summary)}"
                lines.append(detail)
        else:
            lines.append("  - none")

        project_roots = [str(path) for path in self.config.project_search_roots if path.exists()]
        if project_roots:
            lines.append(f"- project search roots: {', '.join(project_roots)}")

        return "\n".join(lines)

    def _truncate_snapshot_line(self, text: str, limit: int = 140) -> str:
        cleaned = " ".join(text.split())
        if len(cleaned) <= limit:
            return cleaned
        return cleaned[: limit - 1].rstrip() + "…"

    def _record_hermes_turn(
        self,
        *,
        repo_path: str,
        title: str,
        prompt: str,
        reply: str,
        transport: str,
        started_at: datetime | None = None,
    ) -> None:
        now = datetime.now()
        session = Session(
            session_id=f"hermes_{uuid.uuid4().hex[:8]}",
            title=title,
            repo_path=repo_path,
            command=self._hermes_command_label(prompt, transport),
            status=SessionStatus.FINISHED,
            started_at=started_at or now,
            finished_at=now,
            exit_code=0,
            output_tail=[reply],
            summary=reply,
        )
        self.store.update(session)

    def _record_hermes_failure(
        self,
        *,
        repo_path: str,
        title: str,
        prompt: str,
        summary: str,
        started_at: datetime,
    ) -> None:
        session = Session(
            session_id=f"hermes_{uuid.uuid4().hex[:8]}",
            title=title,
            repo_path=repo_path,
            command=self._hermes_command_label(prompt, "acp"),
            status=SessionStatus.FAILED,
            started_at=started_at,
            finished_at=datetime.now(),
            exit_code=1,
            output_tail=[summary],
            summary=summary,
        )
        self.store.update(session)

    def _hermes_command_label(self, prompt: str, transport: str) -> str:
        if transport == "acp":
            return f"{self.hermes.hermes_cmd} acp session/prompt {prompt[:80].strip()}"
        return " ".join(self.hermes.build_cli_command(prompt))


def build_app(config: AppConfig | None = None) -> XRAgentApp:
    config = config or AppConfig()
    config.state_dir.mkdir(parents=True, exist_ok=True)
    auto_open_debug_log_terminal = os.environ.get("XR_AGENT_OPEN_DEBUG_TAILS", "0") == "1"
    store = SessionStore(state_path=config.state_dir / "sessions.json")
    runner = SessionRunner(store, max_output_tail_lines=config.max_output_tail_lines)
    router = CommandRouter()
    speech = SpeechService()
    summarizer = Summarizer()
    hermes = HermesAdapter(
        hermes_cmd=config.hermes_cmd,
        prompt_template_path=(
            Path(__file__).resolve().parents[4]
            / "shared"
            / "prompts"
            / "followup_prompt.md"
        ),
    )
    hermes_runtime = PersistentHermesRuntime(adapter=hermes)
    coding_sessions = ManagedCodingSessionManager(
        log_dir=config.state_dir / "coding-sessions",
        auto_open_debug_log_terminal=auto_open_debug_log_terminal,
    )
    events = EventServer()
    control = ControlServer()
    app = XRAgentApp(
        config=config,
        store=store,
        runner=runner,
        router=router,
        speech=speech,
        summarizer=summarizer,
        hermes=hermes,
        hermes_runtime=hermes_runtime,
        coding_sessions=coding_sessions,
        events=events,
        control=control,
    )
    events.set_message_handler(app.handle_client_message)
    control.set_request_handler(app.handle_control_request)
    return app


def _extract_first_json_object(text: str | None) -> dict[str, Any] | None:
    if not text:
        return None
    decoder = json.JSONDecoder()
    for index, char in enumerate(text):
        if char != "{":
            continue
        try:
            payload, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            return payload
    return None


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="XR coding agent Mac companion")
    parser.add_argument("--repo", default=str(Path.cwd()), help="Repository path for tracked commands")
    parser.add_argument("--event-host", default="0.0.0.0", help="Host interface for the websocket event server")
    parser.add_argument("--event-port", type=int, default=8765, help="Port for the websocket event server")
    parser.add_argument("--control-host", default="127.0.0.1", help="Host interface for the Hermes control bridge")
    parser.add_argument("--control-port", type=int, default=8766, help="Port for the Hermes control bridge")
    parser.add_argument("--command-center-port", type=int, default=0, help="Port for the local command center web UI")
    parser.add_argument("--open-command-center", action="store_true", help="Open the command center in your browser on launch")
    parser.add_argument("--once", help="Run one command and print the response")
    parser.add_argument("--show-events", action="store_true", help="Print emitted events after a one-shot command")
    parser.add_argument("--server", action="store_true", help="Run only the websocket server and keep the companion alive")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    app = build_app(
        AppConfig(
            default_repo_path=Path(args.repo),
            event_host=args.event_host,
            event_port=args.event_port,
            control_host=args.control_host,
            control_port=args.control_port,
            command_center_port=args.command_center_port,
            command_center_open_browser=args.open_command_center,
        )
    )
    repo_path = args.repo

    app.start()
    try:
        if args.once:
            response = app.handle_text(args.once, repo_path=repo_path)
            print(response["message"])
            exit_code = 0
            session_id = response.get("session_id")
            if session_id:
                completed = app.wait_for_session(session_id, timeout=60)
                if completed is not None:
                    if completed.summary:
                        print(completed.summary)
                    if completed.exit_code is not None:
                        exit_code = completed.exit_code
            if args.show_events:
                for event in app.events.recent_serialized():
                    print(json.dumps(event))
            return exit_code

        print("XR coding agent ready.")
        print(f"State dir: {app.config.state_dir}")
        print(f"Repo path: {repo_path}")
        print(f"WebSocket: ws://{app.config.event_host}:{app.config.event_port}")
        print(f"Hermes control: tcp://{app._control_bridge_connect_host()}:{app.control.bound_port}")
        if app.command_center_url is not None:
            print(f"Command Center: {app.command_center_url}")
        if args.server or not sys.stdin.isatty():
            print("Server mode active. Press Ctrl+C to exit.")
            try:
                while True:
                    time.sleep(1)
            except KeyboardInterrupt:
                print("\nbye")
            return 0

        print("Type a command like 'run tests' or 'what happened?'. Ctrl+C to exit.")
        while True:
            try:
                raw = input("> ").strip()
            except (EOFError, KeyboardInterrupt):
                print("\nbye")
                break
            if not raw:
                continue
            response = app.handle_text(raw, repo_path=repo_path)
            print(response["message"])
        return 0
    finally:
        app.stop()

_BRAILLE_PATTERN = re.compile(r"[\u2800-\u28ff]")


def _should_skip_output_event(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return True
    if "running" in stripped and "tools concurrently" in stripped:
        return True
    if _BRAILLE_PATTERN.search(stripped) and "running" in stripped:
        return True
    return False


if __name__ == "__main__":
    raise SystemExit(main())
