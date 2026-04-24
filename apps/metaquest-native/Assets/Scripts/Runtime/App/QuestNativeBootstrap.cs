using System.Linq;
using TMPro;
using UnityEngine;
using XRCodingAgent.MetaQuestNative.Networking;
using XRCodingAgent.MetaQuestNative.State;

namespace XRCodingAgent.MetaQuestNative.App
{
    public sealed class QuestNativeBootstrap : MonoBehaviour
    {
        [SerializeField] private QuestBackendBridge? backendBridge;
        [SerializeField] private TextMeshProUGUI? hermesTitleLabel;
        [SerializeField] private TextMeshProUGUI? hermesSubtitleLabel;
        [SerializeField] private TextMeshProUGUI? connectionLabel;
        [SerializeField] private TextMeshProUGUI? workerBoardLabel;
        [SerializeField] private TextMeshProUGUI? workerDetailLabel;

        private void OnEnable()
        {
            if (backendBridge != null)
            {
                backendBridge.StateStore.StateChanged += Refresh;
                Refresh();
            }
        }

        private void OnDisable()
        {
            if (backendBridge != null)
            {
                backendBridge.StateStore.StateChanged -= Refresh;
            }
        }

        public async void SendHermesPrompt(string prompt)
        {
            if (backendBridge == null || string.IsNullOrWhiteSpace(prompt))
            {
                return;
            }

            await backendBridge.SendVoiceCommandAsync(prompt);
        }

        public async void RefreshWorkerBoard()
        {
            if (backendBridge == null)
            {
                return;
            }

            await backendBridge.RequestCodingSessionSyncAsync();
        }

        public async void ApproveFocusedWorker()
        {
            if (backendBridge == null)
            {
                return;
            }

            var pending = backendBridge.StateStore.Sessions.FirstOrDefault(session => session.WaitingOnUser);
            if (pending == null)
            {
                return;
            }

            await backendBridge.SendWorkerReplyAsync(pending.SessionId, "approve", true);
        }

        private void Refresh()
        {
            if (backendBridge == null)
            {
                return;
            }

            var store = backendBridge.StateStore;
            var phase = store.HermesPhase;
            var leadWorker = store.Sessions.FirstOrDefault();

            if (hermesTitleLabel != null)
            {
                hermesTitleLabel.text = phase.Title;
            }

            if (hermesSubtitleLabel != null)
            {
                hermesSubtitleLabel.text = phase.Subtitle;
            }

            if (connectionLabel != null)
            {
                connectionLabel.text = store.StatusText;
            }

            if (workerBoardLabel != null)
            {
                workerBoardLabel.text = store.Sessions.Count == 0
                    ? "No active workers yet."
                    : string.Join("\n", store.Sessions.Take(4).Select(session =>
                        $"{session.DisplayLabel}: {(session.WaitingOnUser ? "waiting" : session.WorkerPhase ?? session.Status.ToString())}"));
            }

            if (workerDetailLabel != null)
            {
                workerDetailLabel.text = leadWorker == null
                    ? "Ask Hermes to open Claude or Codex."
                    : leadWorker.PendingQuestion
                        ?? leadWorker.ManagerSummary
                        ?? leadWorker.ScreenText
                        ?? string.Join("\n", leadWorker.OutputTail.TakeLast(10));
            }
        }
    }
}
