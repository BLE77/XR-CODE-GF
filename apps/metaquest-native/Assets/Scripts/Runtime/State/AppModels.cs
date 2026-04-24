using System;
using System.Collections.Generic;

namespace XRCodingAgent.MetaQuestNative.State
{
    public enum CodingSessionStatus
    {
        Running,
        Closing,
        Finished,
        Failed,
    }

    public enum HermesSurfaceTone
    {
        Calm,
        Working,
        Attention,
        Success,
    }

    public enum AvatarMode
    {
        Idle,
        Listening,
        Thinking,
        Speaking,
        Working,
        Alert,
        Ready,
    }

    [Serializable]
    public sealed class CodingSessionSnapshot
    {
        public string SessionId = string.Empty;
        public string Title = "Worker session";
        public string? Intent;
        public string? RepoPath;
        public string? Command;
        public CodingSessionStatus Status = CodingSessionStatus.Running;
        public int? Pid;
        public int? ExitCode;
        public string? Summary;
        public string? LogPath;
        public string? WorkerLabel;
        public string? TaskTitle;
        public string? WorkerPhase;
        public string? StatusText;
        public string? ManagerSummary;
        public bool WaitingOnUser;
        public bool NeedsReview;
        public string? BlockedReason;
        public string? PendingQuestion;
        public string? LastUpdate;
        public string? ScreenText;
        public int? ScreenRows;
        public int? ScreenColumns;
        public readonly List<string> OutputTail = new();

        public string DisplayLabel => !string.IsNullOrWhiteSpace(WorkerLabel) ? WorkerLabel! : Title;
    }

    [Serializable]
    public sealed class HermesPhaseSnapshot
    {
        public string Title = "Standing By";
        public string Subtitle = "Hermes is ready to manage the next coding task.";
        public HermesSurfaceTone Tone = HermesSurfaceTone.Calm;
    }

    [Serializable]
    public sealed class AvatarSignalState
    {
        public AvatarMode Mode = AvatarMode.Idle;
        public string? Transcript;
        public string? SpokenText;
        public DateTime LastChangedAtUtc = DateTime.UtcNow;
    }
}
