using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using UnityEngine;
using XRCodingAgent.MetaQuestNative.Protocol;
using XRCodingAgent.MetaQuestNative.State;

namespace XRCodingAgent.MetaQuestNative.Networking
{
    public sealed class QuestBackendBridge : MonoBehaviour
    {
        [SerializeField] private string host = "192.168.1.152";
        [SerializeField] private int port = 8765;
        [SerializeField] private string defaultRepoPath = "/Users/7upa/Desktop/xr-coding-agent";
        [SerializeField] private bool connectOnStart = true;

        private readonly ConcurrentQueue<Action> _mainThreadQueue = new();
        private readonly QuestNativeStateStore _stateStore = new();
        private readonly JsonSerializerSettings _jsonSettings = new()
        {
            MissingMemberHandling = MissingMemberHandling.Ignore,
            NullValueHandling = NullValueHandling.Include,
        };

        private ClientWebSocket? _socket;
        private CancellationTokenSource? _cancellation;

        public QuestNativeStateStore StateStore => _stateStore;

        private void Start()
        {
            if (connectOnStart)
            {
                _ = ConnectAsync();
            }
        }

        private void Update()
        {
            while (_mainThreadQueue.TryDequeue(out var action))
            {
                action.Invoke();
            }
        }

        private void OnDestroy()
        {
            _ = DisconnectAsync();
        }

        public async Task ConnectAsync()
        {
            await DisconnectAsync();

            _stateStore.MarkConnecting(host, port);
            _socket = new ClientWebSocket();
            _cancellation = new CancellationTokenSource();

            try
            {
                var uri = new Uri($"ws://{host}:{port}");
                await _socket.ConnectAsync(uri, _cancellation.Token);
                Enqueue(() => _stateStore.MarkConnected(host, port));
                _ = ReceiveLoopAsync(_socket, _cancellation.Token);
                await RequestCodingSessionSyncAsync();
            }
            catch (Exception exception)
            {
                Debug.LogError($"Failed to connect to Hermes backend: {exception}");
                Enqueue(() => _stateStore.MarkDisconnected($"Connection failed: {exception.Message}"));
            }
        }

        public async Task DisconnectAsync()
        {
            try
            {
                _cancellation?.Cancel();
                if (_socket is { State: WebSocketState.Open })
                {
                    await _socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Client disconnect", CancellationToken.None);
                }
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"QuestBackendBridge disconnect warning: {exception.Message}");
            }
            finally
            {
                _socket?.Dispose();
                _socket = null;
                _cancellation?.Dispose();
                _cancellation = null;
                Enqueue(() => _stateStore.MarkDisconnected());
            }
        }

        public Task SendVoiceCommandAsync(string text, string? repoPath = null)
        {
            return SendAsync(new Dictionary<string, object?>
            {
                ["type"] = "voice.command",
                ["payload"] = new Dictionary<string, object?>
                {
                    ["text"] = text,
                    ["repo_path"] = string.IsNullOrWhiteSpace(repoPath) ? defaultRepoPath : repoPath,
                },
            }, "Sent command to Hermes.");
        }

        public Task RequestCodingSessionSyncAsync()
        {
            return SendAsync(new Dictionary<string, object?>
            {
                ["type"] = "coding_sessions.sync",
                ["payload"] = new Dictionary<string, object?>(),
            }, "Refreshing worker board...");
        }

        public Task SendWorkerReplyAsync(string sessionId, string text, bool routeViaManager = true)
        {
            return SendAsync(new Dictionary<string, object?>
            {
                ["type"] = "worker.reply",
                ["payload"] = new Dictionary<string, object?>
                {
                    ["session_id"] = sessionId,
                    ["text"] = text,
                    ["route_via_manager"] = routeViaManager,
                },
            }, routeViaManager ? "Hermes is routing your worker reply." : "Sent direct worker reply.");
        }

        public Task SendTerminalInputAsync(string sessionId, string text)
        {
            return SendAsync(new Dictionary<string, object?>
            {
                ["type"] = "terminal.input",
                ["payload"] = new Dictionary<string, object?>
                {
                    ["session_id"] = sessionId,
                    ["text"] = text,
                },
            }, "Sent direct input to the worker.");
        }

        public Task OpenProjectPickerAsync(string? startingPath = null)
        {
            return SendAsync(new Dictionary<string, object?>
            {
                ["type"] = "project.pick_folder",
                ["payload"] = new Dictionary<string, object?>
                {
                    ["starting_path"] = string.IsNullOrWhiteSpace(startingPath) ? defaultRepoPath : startingPath,
                },
            }, "Opening project picker on Mac...");
        }

        private async Task SendAsync(object payload, string successStatus)
        {
            if (_socket is not { State: WebSocketState.Open })
            {
                Enqueue(() => _stateStore.MarkStatus("Connect to the Mac companion first."));
                return;
            }

            try
            {
                var json = JsonConvert.SerializeObject(payload, _jsonSettings);
                var buffer = Encoding.UTF8.GetBytes(json);
                await _socket.SendAsync(new ArraySegment<byte>(buffer), WebSocketMessageType.Text, true, _cancellation?.Token ?? CancellationToken.None);
                Enqueue(() => _stateStore.MarkStatus(successStatus));
            }
            catch (Exception exception)
            {
                Debug.LogError($"Failed to send websocket payload: {exception}");
                Enqueue(() => _stateStore.MarkStatus($"Send failed: {exception.Message}"));
            }
        }

        private async Task ReceiveLoopAsync(ClientWebSocket socket, CancellationToken cancellationToken)
        {
            var buffer = new byte[64 * 1024];

            while (!cancellationToken.IsCancellationRequested && socket.State == WebSocketState.Open)
            {
                try
                {
                    var builder = new StringBuilder();
                    WebSocketReceiveResult result;
                    do
                    {
                        result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken);
                        if (result.MessageType == WebSocketMessageType.Close)
                        {
                            Enqueue(() => _stateStore.MarkDisconnected("Backend websocket closed."));
                            return;
                        }

                        builder.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
                    } while (!result.EndOfMessage);

                    var json = builder.ToString();
                    var agentEvent = JsonConvert.DeserializeObject<AgentWireEvent>(json, _jsonSettings);
                    if (agentEvent == null || string.IsNullOrWhiteSpace(agentEvent.Type))
                    {
                        continue;
                    }

                    Enqueue(() => _stateStore.ApplyEvent(agentEvent));
                }
                catch (OperationCanceledException)
                {
                    return;
                }
                catch (Exception exception)
                {
                    Debug.LogError($"QuestBackendBridge receive loop failed: {exception}");
                    Enqueue(() => _stateStore.MarkDisconnected($"Receive failed: {exception.Message}"));
                    return;
                }
            }
        }

        private void Enqueue(Action action)
        {
            _mainThreadQueue.Enqueue(action);
        }
    }
}
