import Foundation

@MainActor
final class EventStreamClient: ObservableObject {
    @Published var isConnected = false
    @Published var events: [AgentWireEvent] = []
    @Published private(set) var codingSessions: [CodingSessionSnapshot] = []
    @Published var pendingCodingSessionWindowID: String?
    @Published var selectedProjectPath: String?
    @Published var statusText = "Not connected"

    private var socketTask: URLSessionWebSocketTask?
    private let decoder = JSONDecoder()
    private(set) var connectionStartedAt = Date.distantFuture
    private var seenEventIDs: Set<String> = []
    private var codingSessionStates: [String: CodingSessionState] = [:]
    private var codingSessionOrder: [String] = []

    func connect(host: String = "127.0.0.1", port: Int = 8765) {
        disconnect()

        guard let url = URL(string: "ws://\(host):\(port)") else {
            statusText = "Invalid websocket URL"
            return
        }

        let session = URLSession(configuration: .default)
        let task = session.webSocketTask(with: url)
        socketTask = task
        connectionStartedAt = Date()
        task.resume()
        isConnected = false
        statusText = "Connecting to \(host):\(port)..."
        verifyConnection(host: host, port: port)
        receiveNextMessage()
    }

    func disconnect() {
        socketTask?.cancel(with: .goingAway, reason: nil)
        socketTask = nil
        connectionStartedAt = Date.distantFuture
        isConnected = false
        if statusText == "Not connected" {
            return
        }
        statusText = "Disconnected"
    }

    func shouldAutoSpeak(_ event: AgentWireEvent) -> Bool {
        guard event.type == "assistant.reply" else {
            return false
        }
        guard let eventDate = event.parsedDate else {
            return false
        }
        return eventDate >= connectionStartedAt.addingTimeInterval(-0.5)
    }

    func clear() {
        events.removeAll()
        codingSessions.removeAll()
        selectedProjectPath = nil
        seenEventIDs.removeAll()
        codingSessionStates.removeAll()
        codingSessionOrder.removeAll()
    }

    func sendCommand(_ text: String, repoPath: String? = nil) async -> Bool {
        guard let socketTask else {
            statusText = "Connect to the Mac companion first"
            return false
        }

        var payload: [String: Any] = [
            "type": "voice.command",
            "payload": [
                "text": text
            ]
        ]

        if let repoPath, var messagePayload = payload["payload"] as? [String: Any] {
            messagePayload["repo_path"] = repoPath
            payload["payload"] = messagePayload
        }

        do {
            let data = try JSONSerialization.data(withJSONObject: payload, options: [])
            let string = String(decoding: data, as: UTF8.self)
            try await socketTask.send(.string(string))
            statusText = "Sent command to Mac companion"
            return true
        } catch {
            statusText = "Failed to send command: \(error.localizedDescription)"
            return false
        }
    }

    func sendTerminalInput(sessionID: String, text: String) async -> Bool {
        guard let socketTask else {
            statusText = "Connect to the Mac companion first"
            return false
        }

        let payload: [String: Any] = [
            "type": "terminal.input",
            "payload": [
                "session_id": sessionID,
                "text": text,
            ],
        ]

        do {
            let data = try JSONSerialization.data(withJSONObject: payload, options: [])
            let string = String(decoding: data, as: UTF8.self)
            try await socketTask.send(.string(string))
            statusText = "Sent input to coding session"
            return true
        } catch {
            statusText = "Failed to send session input: \(error.localizedDescription)"
            return false
        }
    }

    func openCodingSession(
        intent: String,
        repoPath: String,
        dangerousSkipPermissions: Bool = false
    ) async -> Bool {
        guard let socketTask else {
            statusText = "Connect to the Mac companion first"
            return false
        }

        let payload: [String: Any] = [
            "type": "coding_session.open",
            "payload": [
                "intent": intent,
                "repo_path": repoPath,
                "dangerously_skip_permissions": dangerousSkipPermissions,
            ],
        ]

        do {
            let data = try JSONSerialization.data(withJSONObject: payload, options: [])
            let string = String(decoding: data, as: UTF8.self)
            try await socketTask.send(.string(string))
            statusText = "Opening coding session..."
            return true
        } catch {
            statusText = "Failed to open coding session: \(error.localizedDescription)"
            return false
        }
    }

    func closeCodingSession(sessionID: String) async -> Bool {
        guard let socketTask else {
            statusText = "Connect to the Mac companion first"
            return false
        }

        let payload: [String: Any] = [
            "type": "coding_session.close",
            "payload": [
                "session_id": sessionID,
            ],
        ]

        do {
            let data = try JSONSerialization.data(withJSONObject: payload, options: [])
            let string = String(decoding: data, as: UTF8.self)
            try await socketTask.send(.string(string))
            markCodingSessionClosing(sessionID: sessionID)
            statusText = "Closing coding session..."
            Task {
                try? await Task.sleep(nanoseconds: 350_000_000)
                await self.requestCodingSessionSync()
            }
            return true
        } catch {
            statusText = "Failed to close coding session: \(error.localizedDescription)"
            return false
        }
    }

    func openCodingSessionLog(sessionID: String) async -> Bool {
        guard let socketTask else {
            statusText = "Connect to the Mac companion first"
            return false
        }

        let payload: [String: Any] = [
            "type": "coding_session.open_log",
            "payload": [
                "session_id": sessionID,
            ],
        ]

        do {
            let data = try JSONSerialization.data(withJSONObject: payload, options: [])
            let string = String(decoding: data, as: UTF8.self)
            try await socketTask.send(.string(string))
            statusText = "Opening session log on Mac..."
            return true
        } catch {
            statusText = "Failed to open session log: \(error.localizedDescription)"
            return false
        }
    }

    func revealCodingSessionLog(sessionID: String) async -> Bool {
        guard let socketTask else {
            statusText = "Connect to the Mac companion first"
            return false
        }

        let payload: [String: Any] = [
            "type": "coding_session.reveal_log",
            "payload": [
                "session_id": sessionID,
            ],
        ]

        do {
            let data = try JSONSerialization.data(withJSONObject: payload, options: [])
            let string = String(decoding: data, as: UTF8.self)
            try await socketTask.send(.string(string))
            statusText = "Revealing session log on Mac..."
            return true
        } catch {
            statusText = "Failed to reveal session log: \(error.localizedDescription)"
            return false
        }
    }

    func requestCodingSessionSync() async {
        guard let socketTask else {
            return
        }
        let payload: [String: Any] = [
            "type": "coding_sessions.sync",
            "payload": [:],
        ]
        do {
            let data = try JSONSerialization.data(withJSONObject: payload, options: [])
            let string = String(decoding: data, as: UTF8.self)
            try await socketTask.send(.string(string))
        } catch {
            statusText = "Failed to refresh coding sessions: \(error.localizedDescription)"
        }
    }

    func requestProjectPicker(startingPath: String? = nil) async -> Bool {
        guard let socketTask else {
            statusText = "Connect to the Mac companion first"
            return false
        }

        var messagePayload: [String: Any] = [:]
        if let startingPath, !startingPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            messagePayload["starting_path"] = startingPath
        }

        let payload: [String: Any] = [
            "type": "project.pick_folder",
            "payload": messagePayload,
        ]

        do {
            let data = try JSONSerialization.data(withJSONObject: payload, options: [])
            let string = String(decoding: data, as: UTF8.self)
            try await socketTask.send(.string(string))
            statusText = "Opening Mac folder picker..."
            return true
        } catch {
            statusText = "Failed to open Mac folder picker: \(error.localizedDescription)"
            return false
        }
    }

    var phase: AssistantPhase {
        guard let latest = events.first(where: {
            [
                "avatar.listening",
                "avatar.speaking",
                "assistant.reply",
                "avatar.thinking",
                "session.started",
                "session.finished",
                "session.failed",
            ].contains($0.type)
        }) else {
            return .idle
        }

        switch latest.type {
        case "avatar.listening":
            return .listening
        case "avatar.speaking", "assistant.reply":
            return .speaking
        case "avatar.thinking", "session.started":
            return .thinking
        case "session.failed":
            return .alert
        case "session.finished":
            return .success
        default:
            return .idle
        }
    }

    var latestSummary: String? {
        events.first(where: { ["assistant.reply", "agent.summary", "hermes.status"].contains($0.type) })?.payloadText("text")
    }

    var latestReply: String? {
        events.first(where: { $0.type == "assistant.reply" })?.payloadText("text")
    }

    var latestTranscript: String? {
        events.first(where: { $0.type == "speech.transcript" })?.payloadText("text")
    }

    var activeSession: SessionSnapshot? {
        sessionSnapshots.first(where: { $0.status == .running })
    }

    var latestCompletedSession: SessionSnapshot? {
        sessionSnapshots.first(where: { $0.status == .finished || $0.status == .failed })
    }

    var primaryPendingCodingSession: CodingSessionSnapshot? {
        codingSessions.first(where: { snapshot in
            snapshot.waitingOnUser && snapshot.status == .running
        })
    }

    var liveCodingSessions: [CodingSessionSnapshot] {
        codingSessions.filter { $0.status == .running }
    }

    var signalEvents: [AgentWireEvent] {
        events.filter { event in
            switch event.type {
            case "assistant.reply",
                "hermes.status",
                "project.selected",
                "worker.pending_question",
                "session.finished",
                "session.failed",
                "terminal.finished",
                "terminal.failed":
                return true
            case "worker.updated":
                let phase = event.payloadText("worker_phase") ?? ""
                return ["waiting_on_user", "blocked", "done", "needs_review"].contains(phase)
                    || (event.payloadBool("waiting_on_user") ?? false)
                    || (event.payloadBool("needs_review") ?? false)
            default:
                return false
            }
        }
    }

    func consumePendingCodingSessionWindowID() {
        pendingCodingSessionWindowID = nil
    }

    private func ingest(_ event: AgentWireEvent) {
        guard seenEventIDs.insert(event.id).inserted else {
            return
        }

        if event.type == "project.selected", let path = event.payloadText("path"), !path.isEmpty {
            selectedProjectPath = path
            statusText = "Selected project: \(path)"
        }
        applyCodingSessionEvent(event)
        if event.type != "terminal.screen" {
            events.insert(event, at: 0)
        }
        refreshCodingSessions()
    }

    private func applyCodingSessionEvent(_ event: AgentWireEvent) {
        guard let sessionID = event.session_id else {
            return
        }

        switch event.type {
        case "terminal.started":
            let isNewSession = codingSessionStates[sessionID] == nil
            var state = codingSessionStates[sessionID] ?? CodingSessionState(id: sessionID)
            state.title = event.payloadText("title") ?? state.title ?? "Coding session"
            state.repoPath = event.payloadText("repo_path") ?? state.repoPath
            state.command = event.payloadText("command") ?? state.command
            state.status = .running
            state.logPath = event.payloadText("log_path") ?? state.logPath
            applyWorkerPayload(from: event, to: &state)
            insertCodingSessionIfNeeded(sessionID)
            codingSessionStates[sessionID] = state
            if isNewSession {
                pendingCodingSessionWindowID = sessionID
            }
        case "terminal.output":
            var state = codingSessionStates[sessionID] ?? CodingSessionState(id: sessionID)
            if let line = event.payloadText("line"), !line.isEmpty {
                state.outputTail.append(line)
            }
            state.outputTail = trimOutputTail(state.outputTail)
            state.title = state.title ?? event.payloadText("title") ?? "Coding session"
            state.repoPath = event.payloadText("repo_path") ?? state.repoPath
            state.logPath = event.payloadText("log_path") ?? state.logPath
            applyWorkerPayload(from: event, to: &state)
            insertCodingSessionIfNeeded(sessionID)
            codingSessionStates[sessionID] = state
        case "terminal.input":
            var state = codingSessionStates[sessionID] ?? CodingSessionState(id: sessionID)
            if let line = event.payloadText("text"), !line.isEmpty {
                state.outputTail.append("> \(line)")
            }
            state.outputTail = trimOutputTail(state.outputTail)
            state.title = state.title ?? event.payloadText("title") ?? "Coding session"
            state.repoPath = event.payloadText("repo_path") ?? state.repoPath
            state.logPath = event.payloadText("log_path") ?? state.logPath
            applyWorkerPayload(from: event, to: &state)
            insertCodingSessionIfNeeded(sessionID)
            codingSessionStates[sessionID] = state
        case "worker.updated":
            var state = codingSessionStates[sessionID] ?? CodingSessionState(id: sessionID)
            state.title = event.payloadText("title") ?? state.title ?? "Coding session"
            state.repoPath = event.payloadText("repo_path") ?? state.repoPath
            applyWorkerPayload(from: event, to: &state)
            insertCodingSessionIfNeeded(sessionID)
            codingSessionStates[sessionID] = state
        case "worker.pending_question":
            var state = codingSessionStates[sessionID] ?? CodingSessionState(id: sessionID)
            state.title = event.payloadText("title") ?? state.title ?? "Coding session"
            state.repoPath = event.payloadText("repo_path") ?? state.repoPath
            applyWorkerPayload(from: event, to: &state)
            state.statusText = event.payloadText("status_text") ?? "Waiting on you"
            state.waitingOnUser = true
            if let question = event.payloadText("question"), !question.isEmpty {
                state.pendingQuestion = question
                state.lastUpdate = question
            }
            insertCodingSessionIfNeeded(sessionID)
            codingSessionStates[sessionID] = state
        case "terminal.screen":
            var state = codingSessionStates[sessionID] ?? CodingSessionState(id: sessionID)
            if let text = event.payloadText("screen_text") ?? event.payloadText("screenText") ?? event.payloadText("text") {
                state.screenText = text.isEmpty ? nil : text
            }
            state.screenRows = event.payloadInt("screen_rows") ?? event.payloadInt("screenRows") ?? state.screenRows
            state.screenColumns = event.payloadInt("screen_columns") ?? event.payloadInt("screenColumns") ?? state.screenColumns
            state.title = state.title ?? event.payloadText("title") ?? "Coding session"
            state.repoPath = event.payloadText("repo_path") ?? state.repoPath
            state.command = event.payloadText("command") ?? state.command
            state.logPath = event.payloadText("log_path") ?? state.logPath
            applyWorkerPayload(from: event, to: &state)
            insertCodingSessionIfNeeded(sessionID)
            codingSessionStates[sessionID] = state
        case "terminal.finished":
            var state = codingSessionStates[sessionID] ?? CodingSessionState(id: sessionID)
            state.status = .finished
            state.title = event.payloadText("title") ?? state.title ?? "Coding session"
            state.repoPath = event.payloadText("repo_path") ?? state.repoPath
            state.logPath = event.payloadText("log_path") ?? state.logPath
            applyWorkerPayload(from: event, to: &state)
            state.statusText = event.payloadText("status_text") ?? "Done"
            state.pendingQuestion = nil
            state.waitingOnUser = false
            state.lastUpdate = event.payloadText("last_update") ?? event.payloadText("summary") ?? state.lastUpdate
            insertCodingSessionIfNeeded(sessionID)
            codingSessionStates[sessionID] = state
        case "terminal.failed":
            var state = codingSessionStates[sessionID] ?? CodingSessionState(id: sessionID)
            state.status = .failed
            state.title = event.payloadText("title") ?? state.title ?? "Coding session"
            state.repoPath = event.payloadText("repo_path") ?? state.repoPath
            state.logPath = event.payloadText("log_path") ?? state.logPath
            applyWorkerPayload(from: event, to: &state)
            state.statusText = event.payloadText("status_text") ?? "Failed"
            state.pendingQuestion = nil
            state.waitingOnUser = false
            state.lastUpdate = event.payloadText("last_update") ?? event.payloadText("summary") ?? state.lastUpdate
            insertCodingSessionIfNeeded(sessionID)
            codingSessionStates[sessionID] = state
        default:
            return
        }
    }

    private func applyWorkerPayload(from event: AgentWireEvent, to state: inout CodingSessionState) {
        state.workerLabel = event.payloadText("worker_label") ?? state.workerLabel
        state.taskTitle = event.payloadText("task_title") ?? state.taskTitle
        state.workerPhase = event.payloadText("worker_phase") ?? state.workerPhase
        state.statusText = event.payloadText("status_text") ?? state.statusText
        state.managerSummary = event.payloadText("manager_summary") ?? state.managerSummary
        state.waitingOnUser = event.payloadBool("waiting_on_user") ?? state.waitingOnUser
        state.needsReview = event.payloadBool("needs_review") ?? state.needsReview
        state.blockedReason = event.payloadText("blocked_reason") ?? state.blockedReason
        let pendingQuestion = event.payloadText("pending_question")
        if let pendingQuestion {
            state.pendingQuestion = pendingQuestion.isEmpty ? nil : pendingQuestion
        }
        state.lastUpdate = event.payloadText("last_update") ?? state.lastUpdate
    }

    private func insertCodingSessionIfNeeded(_ sessionID: String) {
        guard !codingSessionOrder.contains(sessionID) else {
            return
        }
        codingSessionOrder.append(sessionID)
    }

    private func refreshCodingSessions() {
        let prioritizedSessions = codingSessionOrder.reversed().enumerated().compactMap { index, sessionID -> (index: Int, snapshot: CodingSessionSnapshot)? in
            guard let state = codingSessionStates[sessionID] else {
                return nil
            }
            return (
                index: index,
                snapshot: CodingSessionSnapshot(
                    id: state.id,
                    title: state.title ?? "Coding session",
                    repoPath: state.repoPath,
                    command: state.command,
                    status: state.status,
                    workerLabel: state.workerLabel,
                    taskTitle: state.taskTitle,
                    workerPhase: state.workerPhase,
                    statusText: state.statusText,
                    managerSummary: state.managerSummary,
                    waitingOnUser: state.waitingOnUser,
                    needsReview: state.needsReview,
                    blockedReason: state.blockedReason,
                    pendingQuestion: state.pendingQuestion,
                    lastUpdate: state.lastUpdate,
                    outputTail: state.outputTail,
                    screenText: state.screenText,
                    screenRows: state.screenRows,
                    screenColumns: state.screenColumns,
                    logPath: state.logPath
                )
            )
        }

        codingSessions = prioritizedSessions
            .sorted { lhs, rhs in
                let leftRank = lhs.snapshot.status.sortRank
                let rightRank = rhs.snapshot.status.sortRank
                if leftRank != rightRank {
                    return leftRank < rightRank
                }
                return lhs.index < rhs.index
            }
            .map(\.snapshot)
    }

    private func trimOutputTail(_ lines: [String]) -> [String] {
        let maxLines = 16
        guard lines.count > maxLines else {
            return lines
        }
        return Array(lines.suffix(maxLines))
    }

    private func markCodingSessionClosing(sessionID: String) {
        guard var state = codingSessionStates[sessionID] else {
            return
        }
        state.status = .closing
        state.statusText = "Closing"
        state.pendingQuestion = nil
        state.waitingOnUser = false
        state.lastUpdate = "Closing session"
        codingSessionStates[sessionID] = state
        refreshCodingSessions()
    }

    private func receiveNextMessage() {
        socketTask?.receive { [weak self] result in
            guard let self else { return }
            Task { @MainActor in
                switch result {
                case .failure(let error):
                    self.isConnected = false
                    let nsError = error as NSError
                    if self.socketTask == nil || nsError.code == NSURLErrorCancelled {
                        self.statusText = "Disconnected"
                    } else {
                        self.statusText = "WebSocket error: \(error.localizedDescription)"
                    }
                case .success(let message):
                    do {
                        self.isConnected = true
                        let data: Data
                        switch message {
                        case .data(let rawData):
                            data = rawData
                        case .string(let text):
                            data = Data(text.utf8)
                        @unknown default:
                            self.statusText = "Unknown websocket message"
                            self.receiveNextMessage()
                            return
                        }

                        let event = try self.decoder.decode(AgentWireEvent.self, from: data)
                        self.ingest(event)
                    } catch {
                        self.statusText = "Failed to decode event: \(error.localizedDescription)"
                    }
                    self.receiveNextMessage()
                }
            }
        }
    }

    private func verifyConnection(host: String, port: Int) {
        socketTask?.sendPing { [weak self] error in
            guard let self else { return }
            Task { @MainActor in
                if let error {
                    self.isConnected = false
                    self.statusText = "WebSocket error: \(error.localizedDescription)"
                } else {
                    self.isConnected = true
                    self.statusText = "Connected to \(host):\(port)"
                    Task {
                        await self.requestCodingSessionSync()
                    }
                }
            }
        }
    }

    private var sessionSnapshots: [SessionSnapshot] {
        var snapshots: [String: SessionSnapshot] = [:]
        var order: [String] = []

        for event in events.reversed() {
            guard let sessionID = event.session_id else {
                continue
            }

            switch event.type {
            case "session.started":
                if snapshots[sessionID] == nil {
                    order.append(sessionID)
                }
                snapshots[sessionID] = SessionSnapshot(
                    id: sessionID,
                    title: event.payloadText("title") ?? "Tracked task",
                    repoPath: event.payloadText("repo_path"),
                    command: event.payloadText("command"),
                    status: .running,
                    summary: snapshots[sessionID]?.summary
                )
            case "session.finished":
                if snapshots[sessionID] == nil {
                    order.append(sessionID)
                }
                snapshots[sessionID] = SessionSnapshot(
                    id: sessionID,
                    title: event.payloadText("title") ?? snapshots[sessionID]?.title ?? "Tracked task",
                    repoPath: snapshots[sessionID]?.repoPath,
                    command: snapshots[sessionID]?.command,
                    status: .finished,
                    summary: event.payloadText("summary") ?? snapshots[sessionID]?.summary
                )
            case "session.failed":
                if snapshots[sessionID] == nil {
                    order.append(sessionID)
                }
                snapshots[sessionID] = SessionSnapshot(
                    id: sessionID,
                    title: event.payloadText("title") ?? snapshots[sessionID]?.title ?? "Tracked task",
                    repoPath: snapshots[sessionID]?.repoPath,
                    command: snapshots[sessionID]?.command,
                    status: .failed,
                    summary: event.payloadText("summary") ?? snapshots[sessionID]?.summary
                )
            case "agent.summary":
                if let existing = snapshots[sessionID] {
                    snapshots[sessionID] = SessionSnapshot(
                        id: existing.id,
                        title: existing.title,
                        repoPath: existing.repoPath,
                        command: existing.command,
                        status: existing.status,
                        summary: event.payloadText("text") ?? existing.summary
                    )
                }
            default:
                continue
            }
        }

        return order.reversed().compactMap { snapshots[$0] }
    }
}

private struct CodingSessionState {
    let id: String
    var title: String?
    var repoPath: String?
    var command: String?
    var status: CodingSessionStatus = .running
    var workerLabel: String?
    var taskTitle: String?
    var workerPhase: String?
    var statusText: String?
    var managerSummary: String?
    var waitingOnUser = false
    var needsReview = false
    var blockedReason: String?
    var pendingQuestion: String?
    var lastUpdate: String?
    var outputTail: [String] = []
    var screenText: String?
    var screenRows: Int?
    var screenColumns: Int?
    var logPath: String?
}
