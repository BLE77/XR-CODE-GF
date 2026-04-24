using System;
using System.Collections.Generic;
using System.Linq;
using XRCodingAgent.MetaQuestNative.Protocol;

namespace XRCodingAgent.MetaQuestNative.State
{
    public sealed class QuestNativeStateStore
    {
        private readonly Dictionary<string, CodingSessionSnapshot> _sessions = new();
        private readonly List<AgentWireEvent> _events = new();
        private readonly HashSet<string> _seenEventIds = new();

        public bool IsConnected { get; private set; }
        public string StatusText { get; private set; } = "Disconnected";
        public string? SelectedProjectPath { get; private set; }
        public HermesPhaseSnapshot HermesPhase { get; } = new();
        public AvatarSignalState AvatarSignal { get; } = new();

        public IReadOnlyList<AgentWireEvent> Events => _events;
        public IReadOnlyList<CodingSessionSnapshot> Sessions =>
            _sessions.Values
                .OrderBy(session => GetStatusRank(session.Status))
                .ThenBy(session => session.DisplayLabel)
                .ToArray();

        public event Action? StateChanged;

        public void MarkConnecting(string host, int port)
        {
            Reset();
            StatusText = $"Connecting to {host}:{port}...";
            IsConnected = false;
            NotifyChanged();
        }

        public void MarkConnected(string host, int port)
        {
            StatusText = $"Connected to {host}:{port}";
            IsConnected = true;
            NotifyChanged();
        }

        public void MarkDisconnected(string reason = "Disconnected")
        {
            IsConnected = false;
            StatusText = reason;
            NotifyChanged();
        }

        public void MarkStatus(string status)
        {
            StatusText = status;
            NotifyChanged();
        }

        public void Reset()
        {
            _sessions.Clear();
            _events.Clear();
            _seenEventIds.Clear();
            SelectedProjectPath = null;
            HermesPhase.Title = "Standing By";
            HermesPhase.Subtitle = "Hermes is ready to manage the next coding task.";
            HermesPhase.Tone = HermesSurfaceTone.Calm;
            AvatarSignal.Mode = AvatarMode.Idle;
            AvatarSignal.Transcript = null;
            AvatarSignal.SpokenText = null;
            AvatarSignal.LastChangedAtUtc = DateTime.UtcNow;
        }

        public void ApplyEvent(AgentWireEvent agentEvent)
        {
            if (!_seenEventIds.Add(agentEvent.EventId))
            {
                return;
            }

            if (agentEvent.Type != "terminal.screen")
            {
                _events.Insert(0, agentEvent);
                if (_events.Count > 200)
                {
                    _events.RemoveAt(_events.Count - 1);
                }
            }

            if (agentEvent.Type == "project.selected")
            {
                SelectedProjectPath = agentEvent.GetString("path") ?? SelectedProjectPath;
            }

            ApplyAvatarSignal(agentEvent);
            ApplySession(agentEvent);
            RecomputeHermesPhase();
            NotifyChanged();
        }

        private void ApplyAvatarSignal(AgentWireEvent agentEvent)
        {
            switch (agentEvent.Type)
            {
                case "speech.transcript":
                    AvatarSignal.Mode = AvatarMode.Listening;
                    AvatarSignal.Transcript = agentEvent.GetString("text");
                    AvatarSignal.SpokenText = null;
                    AvatarSignal.LastChangedAtUtc = DateTime.UtcNow;
                    break;
                case "avatar.thinking":
                    AvatarSignal.Mode = AvatarMode.Thinking;
                    AvatarSignal.Transcript = agentEvent.GetString("text") ?? AvatarSignal.Transcript;
                    AvatarSignal.SpokenText = null;
                    AvatarSignal.LastChangedAtUtc = DateTime.UtcNow;
                    break;
                case "avatar.speaking":
                case "assistant.reply":
                    AvatarSignal.Mode = AvatarMode.Speaking;
                    AvatarSignal.SpokenText = agentEvent.GetString("text") ?? AvatarSignal.SpokenText;
                    AvatarSignal.LastChangedAtUtc = DateTime.UtcNow;
                    break;
            }
        }

        private void ApplySession(AgentWireEvent agentEvent)
        {
            if (string.IsNullOrWhiteSpace(agentEvent.SessionId))
            {
                return;
            }

            var sessionId = agentEvent.SessionId!;
            if (!_sessions.TryGetValue(sessionId, out var session))
            {
                session = new CodingSessionSnapshot
                {
                    SessionId = sessionId,
                };
                _sessions[sessionId] = session;
            }

            session.Intent = agentEvent.GetString("intent") ?? session.Intent;
            session.WorkerLabel = agentEvent.GetString("worker_label") ?? session.WorkerLabel;
            session.TaskTitle = agentEvent.GetString("task_title") ?? session.TaskTitle;
            session.WorkerPhase = agentEvent.GetString("worker_phase") ?? session.WorkerPhase;
            session.StatusText = agentEvent.GetString("status_text") ?? session.StatusText;
            session.ManagerSummary = agentEvent.GetString("manager_summary") ?? session.ManagerSummary;
            session.BlockedReason = agentEvent.GetString("blocked_reason") ?? session.BlockedReason;
            session.RepoPath = agentEvent.GetString("repo_path") ?? session.RepoPath;
            session.Command = agentEvent.GetString("command") ?? session.Command;
            session.LogPath = agentEvent.GetString("log_path") ?? session.LogPath;
            session.Pid = agentEvent.GetInt("pid") ?? session.Pid;
            session.Title = agentEvent.GetString("title") ?? session.Title;
            session.WaitingOnUser = agentEvent.GetBool("waiting_on_user") ?? session.WaitingOnUser;
            session.NeedsReview = agentEvent.GetBool("needs_review") ?? session.NeedsReview;

            switch (agentEvent.Type)
            {
                case "terminal.started":
                    session.Status = CodingSessionStatus.Running;
                    break;
                case "terminal.output":
                    AppendOutput(session, agentEvent.GetString("line"));
                    break;
                case "terminal.input":
                    AppendOutput(session, $"> {agentEvent.GetString("text")}");
                    break;
                case "terminal.screen":
                    session.ScreenText = agentEvent.GetString("screen_text") ?? session.ScreenText;
                    session.ScreenRows = agentEvent.GetInt("screen_rows") ?? session.ScreenRows;
                    session.ScreenColumns = agentEvent.GetInt("screen_columns") ?? session.ScreenColumns;
                    break;
                case "worker.pending_question":
                    session.WaitingOnUser = true;
                    session.PendingQuestion = agentEvent.GetString("question") ?? agentEvent.GetString("pending_question");
                    session.LastUpdate = session.PendingQuestion ?? session.LastUpdate;
                    break;
                case "terminal.finished":
                    session.Status = CodingSessionStatus.Finished;
                    session.ExitCode = agentEvent.GetInt("exit_code") ?? session.ExitCode;
                    session.Summary = agentEvent.GetString("summary") ?? session.Summary;
                    session.WaitingOnUser = false;
                    session.PendingQuestion = null;
                    break;
                case "terminal.failed":
                    session.Status = CodingSessionStatus.Failed;
                    session.ExitCode = agentEvent.GetInt("exit_code") ?? session.ExitCode;
                    session.Summary = agentEvent.GetString("summary") ?? session.Summary;
                    session.WaitingOnUser = false;
                    session.PendingQuestion = null;
                    break;
            }
        }

        private void RecomputeHermesPhase()
        {
            if (AvatarSignal.Mode == AvatarMode.Listening)
            {
                HermesPhase.Title = "Listening";
                HermesPhase.Subtitle = "Hermes is taking in your latest coding instruction.";
                HermesPhase.Tone = HermesSurfaceTone.Working;
                return;
            }

            if (AvatarSignal.Mode == AvatarMode.Thinking)
            {
                HermesPhase.Title = "Working";
                HermesPhase.Subtitle = "Hermes is coordinating the coding workers.";
                HermesPhase.Tone = HermesSurfaceTone.Working;
                return;
            }

            if (AvatarSignal.Mode == AvatarMode.Speaking)
            {
                HermesPhase.Title = "Speaking";
                HermesPhase.Subtitle = AvatarSignal.SpokenText ?? "Hermes has an update for you.";
                HermesPhase.Tone = HermesSurfaceTone.Success;
                return;
            }

            if (_sessions.Values.Any(session => session.WaitingOnUser))
            {
                HermesPhase.Title = "Needs Attention";
                HermesPhase.Subtitle = "A worker needs a decision from you.";
                HermesPhase.Tone = HermesSurfaceTone.Attention;
                return;
            }

            if (_sessions.Values.Any(session => session.Status == CodingSessionStatus.Failed || session.WorkerPhase == "blocked"))
            {
                HermesPhase.Title = "Blocked";
                HermesPhase.Subtitle = "A worker hit a blocker and Hermes is surfacing it.";
                HermesPhase.Tone = HermesSurfaceTone.Attention;
                return;
            }

            var latest = _events.FirstOrDefault();
            if (latest is null)
            {
                HermesPhase.Title = "Standing By";
                HermesPhase.Subtitle = "Hermes is ready to manage the next coding task.";
                HermesPhase.Tone = HermesSurfaceTone.Calm;
                return;
            }

            HermesPhase.Title = latest.Type switch
            {
                "terminal.finished" => "Ready",
                "assistant.reply" => "Ready",
                "agent.summary" => "Ready",
                "terminal.failed" => "Needs Attention",
                _ => "Working",
            };

            HermesPhase.Subtitle = latest.GetString("text")
                ?? latest.GetString("summary")
                ?? latest.GetString("manager_summary")
                ?? latest.GetString("status_text")
                ?? "Hermes is tracking the current coding flow.";

            HermesPhase.Tone = latest.Type switch
            {
                "assistant.reply" => HermesSurfaceTone.Success,
                "agent.summary" => HermesSurfaceTone.Success,
                "terminal.finished" => HermesSurfaceTone.Success,
                "terminal.failed" => HermesSurfaceTone.Attention,
                _ => HermesSurfaceTone.Working,
            };
        }

        private static int GetStatusRank(CodingSessionStatus status)
        {
            return status switch
            {
                CodingSessionStatus.Running => 0,
                CodingSessionStatus.Closing => 1,
                CodingSessionStatus.Finished => 2,
                CodingSessionStatus.Failed => 2,
                _ => 3,
            };
        }

        private static void AppendOutput(CodingSessionSnapshot session, string? line)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                return;
            }

            session.OutputTail.Add(line);
            if (session.OutputTail.Count > 30)
            {
                session.OutputTail.RemoveAt(0);
            }
        }

        private void NotifyChanged()
        {
            StateChanged?.Invoke();
        }
    }
}
