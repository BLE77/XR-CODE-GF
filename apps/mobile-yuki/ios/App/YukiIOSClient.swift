import Foundation

enum YukiAvatarPhase: String {
    case idle
    case listening
    case thinking
    case speaking
    case alert
    case ready
}

@MainActor
final class YukiIOSClient: ObservableObject {
    @Published var host: String {
        didSet {
            UserDefaults.standard.set(host, forKey: Self.hostDefaultsKey)
        }
    }
    @Published var port: String {
        didSet {
            UserDefaults.standard.set(port, forKey: Self.portDefaultsKey)
        }
    }
    @Published var agentName: String {
        didSet {
            UserDefaults.standard.set(agentName, forKey: Self.agentDefaultsKey)
        }
    }
    @Published var eventScheme: String {
        didSet { UserDefaults.standard.set(eventScheme, forKey: Self.eventSchemeDefaultsKey) }
    }
    @Published var realtimePort: String {
        didSet { UserDefaults.standard.set(realtimePort, forKey: Self.realtimePortDefaultsKey) }
    }
    @Published var realtimeToken: String {
        didSet { YukiSecureStore.set(realtimeToken, account: Self.realtimeTokenAccount) }
    }
    @Published var realtimeScheme: String {
        didSet { UserDefaults.standard.set(realtimeScheme, forKey: Self.realtimeSchemeDefaultsKey) }
    }
    @Published private(set) var isConnected = false
    @Published private(set) var isRealtimeConnected = false
    @Published private(set) var isMicrophoneMuted: Bool
    @Published private(set) var realtimeStatus = "Live voice not connected"
    @Published private(set) var statusText = "Disconnected"
    @Published private(set) var avatarPhase: YukiAvatarPhase = .idle
    @Published private(set) var latestReply: String?
    @Published private(set) var latestTranscript: String?
    @Published private(set) var events: [AgentWireEvent] = []

    private static let hostDefaultsKey = "xr.ios.mac_companion_host"
    private static let portDefaultsKey = "xr.ios.mac_companion_port"
    private static let agentDefaultsKey = "xr.ios.agent_name"
    private static let eventSchemeDefaultsKey = "xr.ios.event_scheme"
    private static let realtimePortDefaultsKey = "xr.ios.realtime_port"
    private static let realtimeTokenAccount = "mobile-yuki-realtime-token"
    private static let realtimeSchemeDefaultsKey = "xr.ios.realtime_scheme"
    private static let microphoneMutedDefaultsKey = "xr.ios.microphone_muted"

    private var socketTask: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var avatarResetTask: Task<Void, Never>?
    private let decoder = JSONDecoder()
    private lazy var realtimeAudio: YukiRealtimeAudioController = {
        let controller = YukiRealtimeAudioController()
        controller.onState = { [weak self] state, detail in
            self?.ingestRealtimeState(state, detail: detail)
        }
        controller.onTranscript = { [weak self] text, isFinal, isUser in
            self?.ingestRealtimeTranscript(text, isFinal: isFinal, isUser: isUser)
        }
        return controller
    }()

    init() {
        self.host = UserDefaults.standard.string(forKey: Self.hostDefaultsKey) ?? "127.0.0.1"
        self.port = UserDefaults.standard.string(forKey: Self.portDefaultsKey) ?? "8765"
        self.agentName = UserDefaults.standard.string(forKey: Self.agentDefaultsKey) ?? "yuki"
        self.eventScheme = UserDefaults.standard.string(forKey: Self.eventSchemeDefaultsKey) ?? "ws"
        self.realtimePort = UserDefaults.standard.string(forKey: Self.realtimePortDefaultsKey) ?? "8789"
        self.realtimeToken = YukiSecureStore.load(account: Self.realtimeTokenAccount) ?? ""
        self.realtimeScheme = UserDefaults.standard.string(forKey: Self.realtimeSchemeDefaultsKey) ?? "ws"
        self.isMicrophoneMuted = UserDefaults.standard.bool(forKey: Self.microphoneMutedDefaultsKey)
    }

    func connect() {
        disconnect()

        let trimmedHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedPort = port.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedHost.isEmpty, let portNumber = Int(trimmedPort) else {
            statusText = "Enter a Mac host and port"
            return
        }
        let socketScheme = eventScheme == "wss" ? "wss" : "ws"
        guard let url = URL(string: "\(socketScheme)://\(trimmedHost):\(portNumber)") else {
            statusText = "Invalid websocket URL"
            return
        }

        let task = URLSession(configuration: .default).webSocketTask(with: url)
        socketTask = task
        statusText = "Connecting to \(trimmedHost):\(portNumber)"
        task.resume()
        receiveMessages(from: task)

        Task {
            do {
                try await sendWireMessage(["type": "coding_sessions.sync", "payload": [:]], updateStatus: false)
                isConnected = true
                statusText = "Connected to \(trimmedHost):\(portNumber)"
            } catch {
                isConnected = false
                statusText = "Connect failed: \(error.localizedDescription)"
            }
        }
    }

    func disconnect() {
        receiveTask?.cancel()
        receiveTask = nil
        avatarResetTask?.cancel()
        avatarResetTask = nil
        socketTask?.cancel(with: .goingAway, reason: nil)
        socketTask = nil
        isConnected = false
        statusText = "Disconnected"
    }

    @discardableResult
    func applyDeepLink(_ url: URL) -> Bool {
        guard ["yukimobile", "yuki"].contains(url.scheme?.lowercased() ?? "") else {
            statusText = "Unsupported Mobile Yuki link"
            return false
        }
        guard ["connect", "c"].contains(url.host?.lowercased() ?? "") else {
            statusText = "Unsupported Mobile Yuki action"
            return false
        }

        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        var params: [String: String] = [:]
        for item in components?.queryItems ?? [] {
            if let value = item.value {
                params[item.name] = value
            }
        }

        let platform = (params["platform"] ?? params["pf"])?.lowercased() ?? "auto"
        guard platform == "auto" || platform == "ios" else {
            statusText = "This Mobile Yuki QR is for \(platform)"
            return false
        }
        let nextEventScheme = (params["scheme"] ?? params["s"] ?? "ws").lowercased()
        guard nextEventScheme == "ws" || nextEventScheme == "wss" else {
            statusText = "Only ws/wss Mobile Yuki links are supported"
            return false
        }
        guard let nextHost = (params["host"] ?? params["h"])?.trimmingCharacters(in: .whitespacesAndNewlines), !nextHost.isEmpty else {
            statusText = "Mobile Yuki link is missing host"
            return false
        }

        let nextPort = (params["port"] ?? params["p"])?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "8765"
        host = nextHost
        port = nextPort.isEmpty ? "8765" : nextPort
        eventScheme = nextEventScheme
        realtimePort = (params["realtimePort"] ?? params["rp"])?.trimmingCharacters(in: .whitespacesAndNewlines) ?? realtimePort
        realtimeToken = (params["realtimeToken"] ?? params["t"])?.trimmingCharacters(in: .whitespacesAndNewlines) ?? realtimeToken
        realtimeScheme = (params["realtimeScheme"] ?? params["rs"] ?? nextEventScheme).trimmingCharacters(in: .whitespacesAndNewlines)
        if let nextAgent = (params["agent"] ?? params["a"])?.trimmingCharacters(in: .whitespacesAndNewlines), !nextAgent.isEmpty {
            agentName = nextAgent
        }
        statusText = "Opening Mobile Yuki link"
        if realtimeToken.isEmpty {
            connect()
        } else {
            statusText = "Secure Realtime session"
        }
        connectRealtimeIfConfigured()
        return true
    }

    func toggleRealtime() {
        if isRealtimeConnected {
            realtimeAudio.disconnect()
        } else {
            connectRealtimeIfConfigured()
        }
    }

    func connectRealtimeIfConfigured() {
        guard let portNumber = Int(realtimePort), !realtimeToken.isEmpty else {
            realtimeStatus = "Scan an authenticated Mobile Yuki QR first"
            return
        }
        realtimeAudio.setMicrophoneMuted(isMicrophoneMuted)
        realtimeAudio.connect(
            host: host.trimmingCharacters(in: .whitespacesAndNewlines),
            port: portNumber,
            scheme: realtimeScheme,
            token: realtimeToken
        )
    }

    func toggleMicrophoneMute() {
        isMicrophoneMuted.toggle()
        UserDefaults.standard.set(isMicrophoneMuted, forKey: Self.microphoneMutedDefaultsKey)
        realtimeAudio.setMicrophoneMuted(isMicrophoneMuted)
        realtimeStatus = isMicrophoneMuted ? "Microphone muted" : "Microphone on"
    }

    func cancelRealtimeReply() {
        realtimeAudio.cancelResponse()
    }

    func sendTextCommand(_ text: String, repoPath: String? = nil) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return false
        }

        if isRealtimeConnected, realtimeAudio.sendTextCommand(trimmed) {
            avatarPhase = .thinking
            latestTranscript = trimmed
            statusText = "Queued through secure Realtime"
            return true
        }

        var payload: [String: Any] = ["text": trimmed]
        if let repoPath, !repoPath.isEmpty {
            payload["repo_path"] = repoPath
        }

        do {
            try await sendWireMessage(["type": "voice.command", "payload": payload])
            avatarPhase = .listening
            latestTranscript = trimmed
            scheduleAvatarReset(durationMs: 1800)
            return true
        } catch {
            statusText = "Send failed: \(error.localizedDescription)"
            return false
        }
    }

    private func receiveMessages(from task: URLSessionWebSocketTask) {
        receiveTask = Task { [weak self] in
            guard let self else {
                return
            }
            while !Task.isCancelled {
                do {
                    let message = try await task.receive()
                    self.handle(message)
                } catch {
                    self.markReceiveStopped(error)
                    return
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let data: Data
        switch message {
        case .data(let rawData):
            data = rawData
        case .string(let text):
            data = Data(text.utf8)
        @unknown default:
            statusText = "Received an unknown websocket message"
            return
        }

        do {
            let event = try decoder.decode(AgentWireEvent.self, from: data)
            ingest(event)
        } catch {
            statusText = "Could not decode event: \(error.localizedDescription)"
        }
    }

    private func ingest(_ event: AgentWireEvent) {
        events.insert(event, at: 0)
        events = Array(events.prefix(80))

        switch event.type {
        case "speech.transcript":
            latestTranscript = event.payloadText("text")
            avatarPhase = .listening
            scheduleAvatarReset(durationMs: 1800)
        case "avatar.thinking":
            avatarPhase = .thinking
            avatarResetTask?.cancel()
        case "avatar.speaking", "assistant.reply":
            latestReply = event.payloadText("text") ?? latestReply
            avatarPhase = .speaking
            scheduleAvatarReset(durationMs: event.payloadInt("duration_ms") ?? 2400)
        case "worker.pending_question", "terminal.failed", "session.failed":
            avatarPhase = .alert
        case "terminal.finished", "session.finished", "agent.summary":
            avatarPhase = .ready
            scheduleAvatarReset(durationMs: 2400)
        default:
            break
        }
    }

    private func markReceiveStopped(_ error: Error) {
        guard socketTask != nil else {
            return
        }
        isConnected = false
        statusText = "Websocket stopped: \(error.localizedDescription)"
    }

    private func sendWireMessage(_ message: [String: Any], updateStatus: Bool = true) async throws {
        guard let socketTask else {
            statusText = "Connect to the Mac companion first"
            throw URLError(.notConnectedToInternet)
        }

        let data = try JSONSerialization.data(withJSONObject: message, options: [])
        let string = String(decoding: data, as: UTF8.self)
        try await socketTask.send(.string(string))
        if updateStatus {
            statusText = "Sent to Hermes"
        }
    }

    private func ingestRealtimeState(_ state: YukiRealtimeAudioController.State, detail: String?) {
        realtimeStatus = detail ?? {
            switch state {
            case .disconnected: return "Live voice disconnected"
            case .connecting: return "Connecting live voice"
            case .authenticated: return "Live voice authenticated"
            case .ready: return "Mobile Yuki is live"
            case .listening: return "Listening"
            case .speaking: return "Speaking"
            case .reconnecting: return "Reconnecting live voice"
            case .failed: return "Live voice failed"
            }
        }()
        switch state {
        case .authenticated, .ready, .listening, .speaking:
            isRealtimeConnected = true
        case .disconnected, .failed:
            isRealtimeConnected = false
        case .connecting, .reconnecting:
            break
        }
        switch state {
        case .listening:
            avatarPhase = .listening
        case .speaking:
            avatarPhase = .speaking
        case .ready, .authenticated:
            avatarPhase = .ready
        case .failed:
            avatarPhase = .alert
        default:
            break
        }
    }

    private func ingestRealtimeTranscript(_ text: String, isFinal: Bool, isUser: Bool) {
        if isUser {
            latestTranscript = text
            return
        }
        if isFinal {
            latestReply = text
        } else {
            latestReply = (latestReply ?? "") + text
        }
    }

    private func scheduleAvatarReset(durationMs: Int) {
        avatarResetTask?.cancel()
        let delay = UInt64(max(800, durationMs)) * 1_000_000
        avatarResetTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: delay)
            await MainActor.run {
                guard let self, !Task.isCancelled else {
                    return
                }
                if self.avatarPhase == .listening || self.avatarPhase == .speaking || self.avatarPhase == .ready {
                    self.avatarPhase = .idle
                }
            }
        }
    }
}
