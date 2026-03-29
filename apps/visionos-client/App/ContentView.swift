import AVFoundation
import Speech
import SwiftUI

struct ContentView: View {
    @AppStorage("xr.mac_companion_host") private var macCompanionHost = defaultCompanionHost
    @AppStorage("xr.mac_companion_port") private var macCompanionPort = "8765"
    @AppStorage("xr.current_project_path") private var currentProjectPath = ""
    @AppStorage("xr.saved_project_paths") private var savedProjectPathsData = "[]"
    @Environment(\.openImmersiveSpace) private var openImmersiveSpace
    @Environment(\.dismissImmersiveSpace) private var dismissImmersiveSpace
    @Environment(\.openWindow) private var openWindow
    @EnvironmentObject private var spatialSettings: SpatialAssistantSettings
    @EnvironmentObject private var eventClient: EventStreamClient
    @EnvironmentObject private var voiceManager: VoiceControlManager
    @State private var isImmersiveSpaceOpen = false
    @State private var didApplyInitialModelSelection = false
    @State private var spatialStatusText = "Open spatial mode to place the avatar in your room."
    @State private var poppedOutSessionIDs: Set<String> = []
    @State private var isProjectWorkspaceExpanded = false
    @State private var isWorkerBoardExpanded = true
    @State private var isSignalFeedExpanded = true
    @State private var isMoreToolsExpanded = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    header
                    SpatialPlacementCard(
                        isImmersiveSpaceOpen: isImmersiveSpaceOpen,
                        statusText: spatialStatusText,
                        action: toggleImmersiveSpace
                    )
                    assistantColumn
                }
                .padding(28)
            }
            .navigationTitle("XR Coding Agent")
        }
        .ornament(visibility: .visible, attachmentAnchor: .scene(.bottom), contentAlignment: .center) {
            GlobalVoiceBar(client: eventClient, voiceManager: voiceManager)
        }
        .task {
            if !didApplyInitialModelSelection {
                didApplyInitialModelSelection = true
                spatialSettings.selectedModelName = ModelCatalog.bundled[0].name
                spatialSettings.applyDefaultsForSelectedModel()
            }
            voiceManager.spatialSettings = spatialSettings
            spatialSettings.currentProjectPath = currentProjectPath
            if !eventClient.isConnected {
                connectToMacCompanion()
            }
        }
        .onChange(of: currentProjectPath) { _, newValue in
            spatialSettings.currentProjectPath = newValue
        }
        .onChange(of: eventClient.selectedProjectPath) { _, newValue in
            guard let newValue, !newValue.isEmpty else {
                return
            }
            currentProjectPath = newValue
            persistSavedProjectPath(newValue)
        }
        .onChange(of: spatialSettings.selectedModelName) { _, _ in
            spatialSettings.applyDefaultsForSelectedModel()
        }
        .onChange(of: eventClient.events.first?.id) { _, _ in
            voiceManager.handleIncomingEvent(eventClient.events.first, client: eventClient)
        }
        .onChange(of: spatialSettings.sendCommandRequestID) { _, _ in
            Task {
                await voiceManager.sendCurrentTranscriptIfListening(client: eventClient)
            }
        }
        .onChange(of: eventClient.codingSessions.map(\.id)) { _, sessionIDs in
            poppedOutSessionIDs = poppedOutSessionIDs.intersection(Set(sessionIDs))
        }
        .onChange(of: eventClient.pendingCodingSessionWindowID) { _, sessionID in
            guard let sessionID, !sessionID.isEmpty else {
                return
            }
            guard !poppedOutSessionIDs.contains(sessionID) else {
                eventClient.consumePendingCodingSessionWindowID()
                return
            }
            openWindow(id: codingSessionWindowID, value: sessionID)
            poppedOutSessionIDs.insert(sessionID)
            eventClient.consumePendingCodingSessionWindowID()
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("XR Coding Agent")
                .font(.largeTitle)
                .fontWeight(.bold)

            Text("Hermes keeps the main conversation calm while Claude and Codex do the work in their own windows.")
                .font(.title3)
                .foregroundStyle(.secondary)
        }
    }

    private var assistantColumn: some View {
        VStack(alignment: .leading, spacing: 20) {
            HermesSupervisorCard(client: eventClient)
            AssistantStatusCard(
                client: eventClient,
                phase: voiceManager.isListening ? .listening : eventClient.phase,
                listeningTranscript: voiceManager.liveTranscript,
                macCompanionHost: $macCompanionHost,
                macCompanionPort: $macCompanionPort,
                currentProjectPath: $currentProjectPath,
                connectAction: connectToMacCompanion,
                chooseProjectAction: requestProjectOnMac
            )
            VoiceCommandCard(client: eventClient, voiceManager: voiceManager)
            DisclosureGroup(isExpanded: $isProjectWorkspaceExpanded) {
                ProjectsWorkspaceCard(
                    client: eventClient,
                    currentProjectPath: $currentProjectPath,
                    savedProjectPathsData: $savedProjectPathsData
                )
            } label: {
                Label("Project workspace", systemImage: "folder")
                    .font(.headline)
            }
            .padding(18)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 24))

            DisclosureGroup(isExpanded: $isWorkerBoardExpanded) {
                CodingSessionsCard(client: eventClient)
            } label: {
                Label("Worker board", systemImage: "rectangle.3.group")
                    .font(.headline)
            }
            .padding(18)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 24))

            DisclosureGroup(isExpanded: $isSignalFeedExpanded) {
                EventFeedView(client: eventClient)
            } label: {
                Label("Signal feed", systemImage: "dot.radiowaves.left.and.right")
                    .font(.headline)
            }
            .padding(18)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 24))

            DisclosureGroup(isExpanded: $isMoreToolsExpanded) {
                SessionOverviewCard(client: eventClient)
                QuickCommandsCard()
            } label: {
                Label("More tools", systemImage: "slider.horizontal.3")
                    .font(.headline)
            }
            .padding(18)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 24))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var currentModel: BundledModel {
        ModelCatalog.model(named: spatialSettings.selectedModelName)
    }

    private func toggleImmersiveSpace() {
        Task {
            if isImmersiveSpaceOpen {
                await dismissImmersiveSpace()
                isImmersiveSpaceOpen = false
                spatialStatusText = "Spatial mode closed."
                return
            }

            switch await openImmersiveSpace(id: assistantImmersiveSpaceID) {
            case .opened:
                isImmersiveSpaceOpen = true
                #if targetEnvironment(simulator)
                spatialStatusText = "\(currentModel.displayName) opened in simulator preview. On a real Vision Pro, the avatar will snap to the floor when room tracking finds one."
                #else
                spatialStatusText = "\(currentModel.displayName) opened. The avatar will anchor to the nearest detected floor surface."
                #endif
            case .userCancelled:
                spatialStatusText = "Spatial mode was cancelled."
            case .error:
                spatialStatusText = "Could not open spatial mode right now."
            @unknown default:
                spatialStatusText = "Spatial mode returned an unknown result."
            }
        }
    }

    private func connectToMacCompanion() {
        let host = macCompanionHost.trimmingCharacters(in: .whitespacesAndNewlines)
        let port = Int(macCompanionPort) ?? 8765
        eventClient.connect(host: host.isEmpty ? defaultCompanionHost : host, port: port)
    }

    private func requestProjectOnMac() async {
        let trimmed = currentProjectPath.trimmingCharacters(in: .whitespacesAndNewlines)
        _ = await eventClient.requestProjectPicker(startingPath: trimmed.isEmpty ? nil : trimmed)
    }

    private func persistSavedProjectPath(_ path: String) {
        guard let data = savedProjectPathsData.data(using: .utf8),
              var savedProjects = try? JSONDecoder().decode([String].self, from: data) else {
            if let encoded = try? JSONEncoder().encode([path]) {
                savedProjectPathsData = String(decoding: encoded, as: UTF8.self)
            }
            return
        }

        savedProjects.removeAll { $0 == path || $0.isEmpty }
        savedProjects.insert(path, at: 0)
        guard let encoded = try? JSONEncoder().encode(savedProjects) else {
            return
        }
        savedProjectPathsData = String(decoding: encoded, as: UTF8.self)
    }
}

#if targetEnvironment(simulator)
private let defaultCompanionHost = "127.0.0.1"
#else
private let defaultCompanionHost = "192.168.1.152"
#endif

#Preview(windowStyle: .automatic) {
    ContentView()
}

private struct AssistantStatusCard: View {
    @ObservedObject var client: EventStreamClient
    let phase: AssistantPhase
    let listeningTranscript: String
    @Binding var macCompanionHost: String
    @Binding var macCompanionPort: String
    @Binding var currentProjectPath: String
    let connectAction: () -> Void
    let chooseProjectAction: () async -> Void
    @State private var isOpeningProjectPicker = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .center) {
                Label(phase.title, systemImage: phase.symbolName)
                    .font(.headline)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(phase.tint.opacity(0.15), in: Capsule())
                    .foregroundStyle(phase.tint)
                Spacer()
                Text(client.statusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Text(client.latestSummary ?? phase.subtitle)
                .font(.headline)
                .fontWeight(.semibold)

            if !listeningTranscript.isEmpty {
                statusInset(title: "Listening now", text: listeningTranscript)
            } else if let transcript = client.latestTranscript {
                statusInset(title: "Last voice command", text: transcript)
            }

            VStack(alignment: .leading, spacing: 12) {
                Text("Mac Companion")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                HStack(spacing: 12) {
                    TextField("Host", text: $macCompanionHost)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textFieldStyle(.roundedBorder)

                    TextField("Port", text: $macCompanionPort)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 90)
                }

                HStack(spacing: 12) {
                    Button(client.isConnected ? "Reconnect" : "Connect") {
                        connectAction()
                    }
                    .buttonStyle(.borderedProminent)

                    Button("Disconnect") {
                        client.disconnect()
                    }
                    .buttonStyle(.bordered)
                    .disabled(!client.isConnected)

                    Button("Clear History") {
                        client.clear()
                    }
                    .buttonStyle(.bordered)
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Current Project")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                HStack(spacing: 12) {
                    TextField("/Users/you/path/to/project", text: $currentProjectPath)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textFieldStyle(.roundedBorder)

                    Button(isOpeningProjectPicker ? "Choosing..." : "Choose On Mac") {
                        Task {
                            isOpeningProjectPicker = true
                            await chooseProjectAction()
                            isOpeningProjectPicker = false
                        }
                    }
                    .buttonStyle(.bordered)
                    .disabled(isOpeningProjectPicker || !client.isConnected)
                }

                Text("Voice commands use this project unless you say a different path or choose one on your Mac.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(20)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24))
    }

    private func statusInset(title: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("\"\(text)\"")
                .font(.body)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18))
    }
}

private struct VoiceCommandCard: View {
    @ObservedObject var client: EventStreamClient
    @ObservedObject var voiceManager: VoiceControlManager
    @AppStorage("xr.current_project_path") private var currentProjectPath = ""
    @State private var typedCommand = ""
    @State private var isSendingTypedCommand = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Talk To Hermes")
                .font(.headline)

            Text(
                voiceManager.isListening
                    ? "Speak now. I will send it when you pause, or tap again to send immediately."
                    : "Tap once, speak, and Hermes will send your command when you finish."
            )
            .foregroundStyle(.secondary)

            if let errorText = voiceManager.errorText {
                Text(errorText)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            Button {
                Task {
                    await voiceManager.handlePrimaryButton(client: client)
                }
            } label: {
                Label(voiceManager.buttonTitle, systemImage: voiceManager.buttonSymbol)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)

            Button("Test Avatar Voice") {
                voiceManager.playPreviewSpeech()
            }
            .buttonStyle(.bordered)

            VStack(alignment: .leading, spacing: 10) {
                Text("Type To Hermes")
                    .font(.subheadline)
                    .fontWeight(.semibold)

                TextField("open claude in the mac companion project", text: $typedCommand, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(2...4)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()

                HStack(spacing: 10) {
                    Button(isSendingTypedCommand ? "Sending..." : "Send Typed Command") {
                        Task {
                            await sendTypedCommand()
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(isSendingTypedCommand || typedCommand.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .padding()
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18))

            if let latestReply = client.latestReply {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Latest Hermes Reply")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(latestReply)
                        .font(.body)
                    Button("Replay Last Reply") {
                        voiceManager.replay(text: latestReply)
                    }
                    .buttonStyle(.bordered)
                }
                .padding()
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18))
            }

            Text("The preview card stays still; the room avatar animates in spatial mode.")
                .font(.caption)
                .foregroundStyle(.secondary)

            if voiceManager.awaitingReply {
                Label("Waiting for Hermes to respond", systemImage: "ellipsis.bubble")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(20)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 24))
    }

    private func sendTypedCommand() async {
        let command = typedCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !command.isEmpty else { return }
        isSendingTypedCommand = true
        let sent = await voiceManager.sendTypedCommand(command, client: client, repoPath: normalizedProjectPath())
        if sent {
            typedCommand = ""
        }
        isSendingTypedCommand = false
    }

    private func normalizedProjectPath() -> String? {
        let trimmed = currentProjectPath.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

private struct HermesSupervisorCard: View {
    @ObservedObject var client: EventStreamClient

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Hermes Supervisor")
                    .font(.headline)
                Spacer()
                if let active = displaySession {
                    Text(active.statusText.flatMap { $0.isEmpty ? nil : $0 } ?? active.status.title)
                        .font(.caption)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(.orange.opacity(0.14), in: Capsule())
                        .foregroundStyle(.orange)
                }
            }

            if let pending = client.primaryPendingCodingSession {
                workerSummaryRow(
                    title: pending.workerLabel ?? pending.title,
                    subtitle: pending.taskTitle ?? "Waiting on you",
                    accent: .orange
                )

                if let question = pending.pendingQuestion, !question.isEmpty {
                    Text(question)
                        .font(.body)
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 16))
                }

                Text("Reply naturally, and Hermes will route it back to the right worker.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if let active = displaySession {
                workerSummaryRow(
                    title: active.workerLabel ?? active.title,
                    subtitle: active.taskTitle ?? active.statusText ?? "Working",
                    accent: .blue
                )

                if let managerSummary = active.managerSummary, !managerSummary.isEmpty {
                    Text(managerSummary)
                        .font(.body)
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
                } else if let lastUpdate = active.lastUpdate, !lastUpdate.isEmpty {
                    Text(lastUpdate)
                        .font(.body)
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
                } else {
                    Text("Hermes is tracking the active worker and will surface the next important decision here.")
                        .font(.body)
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("Hermes will surface worker updates and approval questions here once Claude or Codex is running.")
                    .foregroundStyle(.secondary)
            }
        }
        .padding(20)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 24))
    }

    private var displaySession: CodingSessionSnapshot? {
        client.primaryPendingCodingSession ?? client.codingSessions.first
    }

    private func workerSummaryRow(title: String, subtitle: String, accent: Color) -> some View {
        HStack(spacing: 10) {
            Circle()
                .fill(accent.opacity(0.85))
                .frame(width: 9, height: 9)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline)
                    .fontWeight(.semibold)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(accent.opacity(0.10), in: RoundedRectangle(cornerRadius: 16))
    }
}

private struct SpatialPlacementCard: View {
    @EnvironmentObject private var spatialSettings: SpatialAssistantSettings
    let isImmersiveSpaceOpen: Bool
    let statusText: String
    let action: () -> Void

    private var selectedModel: BundledModel {
        ModelCatalog.model(named: spatialSettings.selectedModelName)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Add Character To Space")
                        .font(.title2)
                        .fontWeight(.semibold)
                    Text("Choose your avatar, then place her in the room.")
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }

            VStack(alignment: .leading, spacing: 12) {
                Text("Character")
                    .font(.headline)

                Picker("Model", selection: $spatialSettings.selectedModelName) {
                    ForEach(ModelCatalog.bundled) { model in
                        Text(model.displayName).tag(model.name)
                    }
                }
                .pickerStyle(.menu)

                Text(selectedModel.rigSummary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Text(statusText)
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Avatar Size")
                    Spacer()
                    Text(String(format: "%.2fx", spatialSettings.avatarScale))
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                Slider(
                    value: Binding(
                        get: { Double(spatialSettings.avatarScale) },
                        set: { spatialSettings.avatarScale = Float($0) }
                    ),
                    in: 0.4...1.6
                )

                HStack {
                    Text("Floor Lift")
                    Spacer()
                    Text(String(format: "%.2fm", spatialSettings.avatarLift))
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                Slider(
                    value: Binding(
                        get: { Double(spatialSettings.avatarLift) },
                        set: { spatialSettings.avatarLift = Float($0) }
                    ),
                    in: 0...0.9
                )

                Toggle("Wander A Little", isOn: $spatialSettings.isWandering)
                Toggle("Avoid Furniture", isOn: $spatialSettings.avoidsFurniture)
                Toggle("Face Me When Nearby", isOn: $spatialSettings.facesUserWhenNearby)
                Toggle("Match Room Lighting", isOn: $spatialSettings.matchesRoomLighting)

                if isImmersiveSpaceOpen {
                    Button("Move Character In Front Of Me") {
                        spatialSettings.requestMoveAvatarInFront()
                    }
                    .buttonStyle(.bordered)
                }
            }

            Text("Furniture avoidance and room lighting work best on a real Vision Pro. The simulator can show the layout and motion loop, but it cannot mirror the lighting in your actual room.")
                .font(.caption)
                .foregroundStyle(.secondary)

            Button(action: action) {
                Label(
                    isImmersiveSpaceOpen ? "Close Spatial Mode" : "Place Avatar In Room",
                    systemImage: isImmersiveSpaceOpen ? "xmark.circle.fill" : "visionpro"
                )
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(20)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 24))
    }
}

private struct SessionOverviewCard: View {
    @ObservedObject var client: EventStreamClient

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Task Overview")
                .font(.headline)

            if let active = client.activeSession {
                SessionSnapshotView(
                    title: "Now Tracking",
                    snapshot: active
                )
            } else if let completed = client.latestCompletedSession {
                SessionSnapshotView(
                    title: "Latest Completed Task",
                    snapshot: completed
                )
            } else {
                Text("Start the Mac companion and say a command like 'run tests' to populate this view.")
                    .foregroundStyle(.secondary)
            }
        }
        .padding(20)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 24))
    }
}

private struct ProjectsWorkspaceCard: View {
    @ObservedObject var client: EventStreamClient
    @Binding var currentProjectPath: String
    @Binding var savedProjectPathsData: String
    @State private var launchingIntent: String?

    private var savedProjects: [String] {
        guard let data = savedProjectPathsData.data(using: .utf8),
              let projects = try? JSONDecoder().decode([String].self, from: data) else {
            return []
        }
        return projects
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Projects")
                .font(.headline)

            Text("Save the repos you care about, then open Claude, Codex, or Hermes in the right project with one tap.")
                .foregroundStyle(.secondary)

            HStack(spacing: 12) {
                Button("Save Current Project") {
                    saveCurrentProject()
                }
                .buttonStyle(.borderedProminent)
                .disabled(normalizedCurrentProjectPath == nil)

                Button("Remove Current Project") {
                    removeCurrentProject()
                }
                .buttonStyle(.bordered)
                .disabled(normalizedCurrentProjectPath == nil || !savedProjects.contains(normalizedCurrentProjectPath ?? ""))
            }

            if savedProjects.isEmpty {
                Text("No saved projects yet. Set a Current Project above, then save it here.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(savedProjects, id: \.self) { projectPath in
                    SavedProjectRow(
                        client: client,
                        projectPath: projectPath,
                        currentProjectPath: $currentProjectPath,
                        launchingIntent: $launchingIntent
                    )
                }
            }
        }
        .padding(20)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 24))
    }

    private var normalizedCurrentProjectPath: String? {
        let trimmed = currentProjectPath.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func saveCurrentProject() {
        guard let projectPath = normalizedCurrentProjectPath else {
            return
        }
        var updated = savedProjects.filter { !$0.isEmpty }
        if !updated.contains(projectPath) {
            updated.insert(projectPath, at: 0)
        }
        persist(projects: updated)
    }

    private func removeCurrentProject() {
        guard let projectPath = normalizedCurrentProjectPath else {
            return
        }
        persist(projects: savedProjects.filter { $0 != projectPath })
    }

    private func persist(projects: [String]) {
        guard let data = try? JSONEncoder().encode(projects) else {
            return
        }
        savedProjectPathsData = String(decoding: data, as: UTF8.self)
    }
}

private struct SavedProjectRow: View {
    @ObservedObject var client: EventStreamClient
    let projectPath: String
    @Binding var currentProjectPath: String
    @Binding var launchingIntent: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(projectPath)
                .font(.system(.caption, design: .monospaced))
                .lineLimit(2)

            HStack(spacing: 10) {
                Button("Use This Project") {
                    currentProjectPath = projectPath
                }
                .buttonStyle(.bordered)

                Button(launchingIntent == "open_claude_code:\(projectPath)" ? "Opening..." : "Claude") {
                    Task {
                        launchingIntent = "open_claude_code:\(projectPath)"
                        _ = await client.openCodingSession(intent: "open_claude_code", repoPath: projectPath)
                        launchingIntent = nil
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(launchingIntent != nil)

                Button("Claude Unsafe") {
                    Task {
                        launchingIntent = "open_claude_code:\(projectPath):unsafe"
                        _ = await client.openCodingSession(
                            intent: "open_claude_code",
                            repoPath: projectPath,
                            dangerousSkipPermissions: true
                        )
                        launchingIntent = nil
                    }
                }
                .buttonStyle(.bordered)
                .disabled(launchingIntent != nil)

                Button("Codex") {
                    Task {
                        launchingIntent = "open_codex:\(projectPath)"
                        _ = await client.openCodingSession(intent: "open_codex", repoPath: projectPath)
                        launchingIntent = nil
                    }
                }
                .buttonStyle(.bordered)
                .disabled(launchingIntent != nil)

                Button("Hermes") {
                    Task {
                        launchingIntent = "open_hermes_cli:\(projectPath)"
                        _ = await client.openCodingSession(intent: "open_hermes_cli", repoPath: projectPath)
                        launchingIntent = nil
                    }
                }
                .buttonStyle(.bordered)
                .disabled(launchingIntent != nil)
            }
        }
        .padding()
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
    }
}

private struct SessionSnapshotView: View {
    let title: String
    let snapshot: SessionSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)

            HStack {
                Text(snapshot.title)
                    .font(.title3)
                    .fontWeight(.semibold)
                Spacer()
                Text(snapshot.status.title)
                    .font(.caption)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(snapshot.status.tint.opacity(0.14), in: Capsule())
                    .foregroundStyle(snapshot.status.tint)
            }

            if let summary = snapshot.summary {
                Text(summary)
                    .foregroundStyle(.primary)
            }

            if let command = snapshot.command {
                Text(command)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
            }

            if let repoPath = snapshot.repoPath {
                Text(repoPath)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding()
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
    }
}

private struct QuickCommandsCard: View {
    private let commands = [
        "open codex here",
        "open claude here",
        "tell claude fix the auth bug",
        "what is claude doing",
        "run tests",
        "build this project",
        "what happened?",
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Suggested Voice Commands")
                .font(.headline)

            ForEach(commands, id: \.self) { command in
                Text(command)
                    .font(.system(.body, design: .monospaced))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
            }
        }
        .padding(20)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 24))
    }
}

private struct CodingSessionsCard: View {
    @ObservedObject var client: EventStreamClient

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Live Workers")
                    .font(.headline)
                Spacer()
                Button("Refresh Sessions") {
                    Task {
                        await client.requestCodingSessionSync()
                    }
                }
                .buttonStyle(.bordered)
            }

            if client.codingSessions.isEmpty {
                Text("Open Claude or Codex from Hermes and the active workers will show up here.")
                    .foregroundStyle(.secondary)
            } else {
                let liveSessions = client.liveCodingSessions
                if liveSessions.isEmpty {
                    Text("No live workers right now. Open Claude or Codex and Hermes will track them here.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(liveSessions.prefix(2)) { session in
                        CodingSessionView(client: client, session: session)
                    }
                    if liveSessions.count > 2 {
                        Text("+\(liveSessions.count - 2) more live workers in the background")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(20)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 24))
    }
}

private struct CodingSessionView: View {
    @Environment(\.openWindow) private var openWindow
    @ObservedObject var client: EventStreamClient
    let session: CodingSessionSnapshot
    var isExpanded = false
    @State private var inputText = ""
    @State private var isSending = false
    @State private var isClosing = false
    @State private var isOpeningLog = false
    @State private var isRevealingLog = false
    @State private var showAdvancedControls = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(session.workerLabel ?? session.title)
                        .font(.title3)
                        .fontWeight(.semibold)
                    if let taskTitle = session.taskTitle, !taskTitle.isEmpty {
                        Text(taskTitle)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    if let statusText = session.statusText, !statusText.isEmpty {
                        Text(statusText)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let repoPath = session.repoPath {
                        Text(repoPath)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer()
                Text(session.status.title)
                    .font(.caption)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(session.status.tint.opacity(0.14), in: Capsule())
                    .foregroundStyle(session.status.tint)
            }

            if let managerSummary = session.managerSummary, !managerSummary.isEmpty {
                Text(managerSummary)
                    .font(.body)
                    .padding(12)
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
            }

            if let pendingQuestion = session.pendingQuestion, !pendingQuestion.isEmpty {
                Text(pendingQuestion)
                    .font(.body)
                    .padding(12)
                    .background(.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 14))
            }

            CodingSessionTerminalSurface(
                snapshot: session,
                viewportHeight: isExpanded ? 620 : 220,
                showFootnote: !isExpanded
            )

            HStack(spacing: 10) {
                Button("Open In Window") {
                    openWindow(id: codingSessionWindowID, value: session.id)
                }
                .buttonStyle(.bordered)

                Text("Keep the live TUI in its own window and only use manual controls when you need to step in.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            DisclosureGroup("Advanced controls", isExpanded: $showAdvancedControls) {
                VStack(alignment: .leading, spacing: 12) {
                    if let command = session.command {
                        Text(command)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }

                    HStack(spacing: 10) {
                        Button(isClosing ? "Closing..." : "Close Session") {
                            Task {
                                isClosing = true
                                _ = await client.closeCodingSession(sessionID: session.id)
                                isClosing = false
                            }
                        }
                        .buttonStyle(.bordered)
                        .disabled(isClosing || session.status != .running)

                        if session.logPath != nil {
                            Button(isOpeningLog ? "Opening Log..." : "Open Mac Tail") {
                                Task {
                                    isOpeningLog = true
                                    _ = await client.openCodingSessionLog(sessionID: session.id)
                                    isOpeningLog = false
                                }
                            }
                            .buttonStyle(.bordered)
                            .disabled(isOpeningLog)

                            Button(isRevealingLog ? "Revealing..." : "Reveal Log") {
                                Task {
                                    isRevealingLog = true
                                    _ = await client.revealCodingSessionLog(sessionID: session.id)
                                    isRevealingLog = false
                                }
                            }
                            .buttonStyle(.bordered)
                            .disabled(isRevealingLog)
                        }
                    }

                    HStack(spacing: 12) {
                        TextField("Send to this worker", text: $inputText)
                            .textFieldStyle(.roundedBorder)
                            .disabled(session.status != .running)

                        Button(isSending ? "Sending..." : "Send") {
                            Task {
                                let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
                                guard !text.isEmpty else { return }
                                isSending = true
                                let sent = await client.sendTerminalInput(sessionID: session.id, text: text)
                                if sent {
                                    inputText = ""
                                }
                                isSending = false
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(
                            session.status != .running
                            || isSending
                            || inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        )
                    }
                }
            }
        }
        .padding()
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
    }
}

private struct CodingSessionTerminalSurface: View {
    let snapshot: CodingSessionSnapshot
    var viewportHeight: CGFloat = 260
    var showFootnote = true

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("Terminal", systemImage: "terminal.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Spacer()

                Text(snapshot.screenText != nil ? "Live screen" : "Output tail")
                    .font(.caption2)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(.white.opacity(0.08), in: Capsule())
                    .foregroundStyle(.secondary)

                if let rows = snapshot.screenRows, let columns = snapshot.screenColumns {
                    Text("\(columns)x\(rows)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            ScrollView([.vertical, .horizontal]) {
                VStack(alignment: .leading, spacing: 8) {
                    if let screenText = normalizedScreenText, !screenText.isEmpty {
                        Text(verbatim: screenText)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.green.opacity(0.95))
                            .fixedSize(horizontal: true, vertical: false)
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                            .textSelection(.enabled)
                    } else if snapshot.outputTail.isEmpty {
                        Text("Waiting for terminal output...")
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(Array(snapshot.outputTail.enumerated()), id: \.offset) { index, line in
                            HStack(alignment: .top, spacing: 10) {
                                Text(String(format: "%02d", index + 1))
                                    .font(.system(.caption2, design: .monospaced))
                                    .foregroundStyle(.secondary.opacity(0.9))
                                    .frame(width: 24, alignment: .trailing)

                                Text(line)
                                    .font(.system(.caption, design: .monospaced))
                                    .foregroundStyle(.primary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
            }
            .frame(maxHeight: viewportHeight)
            .background(
                LinearGradient(
                    colors: [
                        Color(red: 0.08, green: 0.10, blue: 0.12),
                        Color(red: 0.05, green: 0.06, blue: 0.08),
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                ),
                in: RoundedRectangle(cornerRadius: 18, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(Color.green.opacity(0.18), lineWidth: 1)
            )

            if showFootnote {
                Text(snapshot.screenText != nil ? "Live screen snapshot." : "Output tail preview.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var normalizedScreenText: String? {
        guard let text = snapshot.screenText else {
            return nil
        }
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        return normalized.isEmpty ? nil : normalized
    }
}

struct TerminalSessionWindowView: View {
    @EnvironmentObject private var client: EventStreamClient
    @EnvironmentObject private var voiceManager: VoiceControlManager
    let sessionID: String

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let session = client.codingSessions.first(where: { $0.id == sessionID }) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(session.title)
                            .font(.largeTitle)
                            .fontWeight(.bold)
                        if let repoPath = session.repoPath {
                            Text(repoPath)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    Spacer()
                    Text(session.status.title)
                        .font(.caption)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(session.status.tint.opacity(0.15), in: Capsule())
                        .foregroundStyle(session.status.tint)
                }

                if let command = session.command {
                    Text(command)
                        .font(.system(.body, design: .monospaced))
                        .foregroundStyle(.secondary)
                }

                HStack(spacing: 12) {
                    Button("Close Session") {
                        Task {
                            _ = await client.closeCodingSession(sessionID: session.id)
                        }
                    }
                    .buttonStyle(.bordered)
                    .disabled(session.status != .running)
                }

                CodingSessionView(client: client, session: session, isExpanded: true)
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Waiting for coding session")
                        .font(.title2)
                        .fontWeight(.semibold)
                    Text("This window will fill in as soon as the matching managed coding session appears.")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            }
        }
        .padding(24)
        .navigationTitle("Coding Session")
        .ornament(visibility: .visible, attachmentAnchor: .scene(.bottom), contentAlignment: .center) {
            GlobalVoiceBar(client: client, voiceManager: voiceManager)
        }
    }
}

private struct GlobalVoiceBar: View {
    @ObservedObject var client: EventStreamClient
    @ObservedObject var voiceManager: VoiceControlManager
    @AppStorage("xr.current_project_path") private var currentProjectPath = ""
    @State private var typedCommand = ""
    @State private var isSendingTypedCommand = false

    var body: some View {
        HStack(spacing: 12) {
            Button {
                Task {
                    await voiceManager.handlePrimaryButton(client: client)
                }
            } label: {
                Label(voiceManager.buttonTitle, systemImage: voiceManager.buttonSymbol)
                    .padding(.horizontal, 8)
            }
            .buttonStyle(.borderedProminent)

            if let latestReply = client.latestReply {
                Button("Replay Hermes") {
                    voiceManager.replay(text: latestReply)
                }
                .buttonStyle(.bordered)
            }

            Group {
                if voiceManager.isListening, !voiceManager.liveTranscript.isEmpty {
                    Text("\"\(voiceManager.liveTranscript)\"")
                } else if let latestReply = client.latestReply {
                    Text(latestReply)
                } else {
                    Text(client.isConnected ? "Connected to Hermes on your Mac." : "Connect to your Mac to talk to Hermes.")
                }
            }
            .font(.caption)
            .lineLimit(2)
            .frame(maxWidth: 420, alignment: .leading)

            TextField("Type to Hermes", text: $typedCommand)
                .textFieldStyle(.roundedBorder)
                .frame(minWidth: 220, maxWidth: 320)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .onSubmit {
                    Task {
                        await sendTypedCommand()
                    }
                }

            Button(isSendingTypedCommand ? "Sending..." : "Send") {
                Task {
                    await sendTypedCommand()
                }
            }
            .buttonStyle(.bordered)
            .disabled(isSendingTypedCommand || typedCommand.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

            if voiceManager.awaitingReply {
                ProgressView()
                    .controlSize(.small)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial, in: Capsule())
    }

    private func sendTypedCommand() async {
        let command = typedCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !command.isEmpty else { return }
        isSendingTypedCommand = true
        let sent = await voiceManager.sendTypedCommand(command, client: client, repoPath: normalizedProjectPath())
        if sent {
            typedCommand = ""
        }
        isSendingTypedCommand = false
    }

    private func normalizedProjectPath() -> String? {
        let trimmed = currentProjectPath.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

@MainActor
final class VoiceControlManager: NSObject, ObservableObject, @preconcurrency AVSpeechSynthesizerDelegate {
    @Published var isListening = false
    @Published var liveTranscript = ""
    @Published var errorText: String?
    @Published var awaitingReply = false

    private let audioEngine = AVAudioEngine()
    private let speechRecognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let speechSynthesizer = AVSpeechSynthesizer()

    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var autoSendTask: Task<Void, Never>?
    private var permissionsResolved = false
    private var microphoneGranted = false
    private var speechGranted = false
    private var lastSpokenEventID: String?
    private weak var connectedClient: EventStreamClient?
    weak var spatialSettings: SpatialAssistantSettings?
    private let autoSendSilenceSeconds: Double = 2.4
    private let shortCommandSilenceSeconds: Double = 3.2

    private enum VoiceControlError: LocalizedError {
        case invalidInputFormat

        var errorDescription: String? {
            switch self {
            case .invalidInputFormat:
                #if targetEnvironment(simulator)
                return "The simulator does not currently expose a valid microphone input format. Run this on a Vision Pro device for headset voice, or reconnect and try again later."
                #else
                return "The headset microphone is not ready yet. Try again in a moment."
                #endif
            }
        }
    }

    var buttonTitle: String {
        isListening ? "Send Now" : "Start Listening"
    }

    var buttonSymbol: String {
        isListening ? "paperplane.fill" : "mic.fill"
    }

    override init() {
        super.init()
        speechSynthesizer.delegate = self
    }

    func handlePrimaryButton(client: EventStreamClient) async {
        if isListening {
            await stopListeningAndSend(client: client)
        } else {
            connectedClient = client
            await startListening()
        }
    }

    func sendCurrentTranscriptIfListening(client: EventStreamClient) async {
        guard isListening else {
            return
        }
        await stopListeningAndSend(client: client)
    }

    func handleIncomingEvent(_ event: AgentWireEvent?, client: EventStreamClient) {
        guard let event, event.id != lastSpokenEventID else {
            return
        }
        guard client.shouldAutoSpeak(event), let text = event.payloadText("text"), !text.isEmpty else {
            return
        }
        guard !isListening else {
            return
        }

        speak(text)
        lastSpokenEventID = event.id
        awaitingReply = false
    }

    func playPreviewSpeech() {
        speak("Hermes is online. Megumin voice preview active.")
    }

    func replay(text: String) {
        speak(text)
    }

    func sendTypedCommand(_ text: String, client: EventStreamClient, repoPath: String?) async -> Bool {
        let command = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !command.isEmpty else {
            errorText = "Type a command first."
            return false
        }

        errorText = nil
        if isListening {
            stopListeningSession()
        }
        speechSynthesizer.stopSpeaking(at: .immediate)
        spatialSettings?.stopSpeakingAnimation()
        awaitingReply = true
        lastSpokenEventID = nil

        let sent = await client.sendCommand(command, repoPath: repoPath)
        if !sent {
            awaitingReply = false
        }
        return sent
    }

    private func startListening() async {
        errorText = nil
        liveTranscript = ""
        speechSynthesizer.stopSpeaking(at: .immediate)
        spatialSettings?.stopSpeakingAnimation()

        #if targetEnvironment(simulator)
        errorText = "Live headset voice capture is only available on a real Vision Pro. The simulator can still preview UI and spatial placement."
        return
        #else
        guard await ensurePermissions() else {
            return
        }
        guard let speechRecognizer, speechRecognizer.isAvailable else {
            errorText = "Speech recognition is unavailable right now."
            return
        }

        do {
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers])
            try audioSession.setPreferredSampleRate(44_100)
            try audioSession.setPreferredInputNumberOfChannels(1)
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

            audioEngine.stop()
            audioEngine.reset()

            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true

            recognitionRequest = request
            recognitionTask = speechRecognizer.recognitionTask(with: request) { [weak self] result, error in
                guard let self else { return }
                Task { @MainActor in
                    if let result {
                        self.liveTranscript = result.bestTranscription.formattedString
                        if !self.liveTranscript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            self.scheduleAutoSend(for: self.liveTranscript)
                        }
                    }

                    if let error, self.isListening {
                        self.errorText = "Speech recognition error: \(error.localizedDescription)"
                        self.stopListeningSession()
                    }
                }
            }

            let inputNode = audioEngine.inputNode
            inputNode.removeTap(onBus: 0)
            let format = try preferredRecordingFormat(for: inputNode)
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                self?.recognitionRequest?.append(buffer)
            }

            audioEngine.prepare()
            try audioEngine.start()
            isListening = true
        } catch {
            errorText = "Could not start listening: \(error.localizedDescription)"
            stopListeningSession()
        }
        #endif
    }

    private func stopListeningAndSend(client: EventStreamClient) async {
        let transcript = liveTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        stopListeningSession()

        guard !transcript.isEmpty else {
            errorText = "I did not hear a command yet. Try again and speak a little longer."
            return
        }

        awaitingReply = true
        lastSpokenEventID = nil

        let repoPath = normalizedProjectPath()
        let sent = await client.sendCommand(transcript, repoPath: repoPath)
        if !sent {
            awaitingReply = false
        }
    }

    private func stopListeningSession() {
        isListening = false
        autoSendTask?.cancel()
        autoSendTask = nil
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionRequest = nil
        recognitionTask = nil

        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            // Best effort cleanup for repeated listen/send cycles.
        }
    }

    private func ensurePermissions() async -> Bool {
        if !permissionsResolved {
            speechGranted = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { status in
                    continuation.resume(returning: status == .authorized)
                }
            }

            microphoneGranted = await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }

            permissionsResolved = true
        }

        guard speechGranted else {
            errorText = "Speech recognition permission is required for headset voice commands."
            return false
        }

        guard microphoneGranted else {
            errorText = "Microphone permission is required for headset voice commands."
            return false
        }

        return true
    }

    private func speak(_ text: String) {
        configurePlaybackAudioSession()
        speechSynthesizer.stopSpeaking(at: .immediate)
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = preferredSpeechVoice()
        utterance.rate = 0.47
        speechSynthesizer.speak(utterance)
    }

    private func configurePlaybackAudioSession() {
        #if targetEnvironment(simulator)
        return
        #else
        do {
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            errorText = "Could not prepare audio playback: \(error.localizedDescription)"
        }
        #endif
    }

    private func preferredSpeechVoice() -> AVSpeechSynthesisVoice? {
        let currentLanguage = AVSpeechSynthesisVoice.currentLanguageCode()
        if let voice = AVSpeechSynthesisVoice(language: currentLanguage) {
            return voice
        }
        if let englishVoice = AVSpeechSynthesisVoice.speechVoices().first(where: { $0.language.hasPrefix("en") }) {
            return englishVoice
        }
        return AVSpeechSynthesisVoice.speechVoices().first
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        spatialSettings?.startSpeakingAnimation()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        spatialSettings?.stopSpeakingAnimation()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        spatialSettings?.stopSpeakingAnimation()
    }

    private func preferredRecordingFormat(for inputNode: AVAudioInputNode) throws -> AVAudioFormat {
        let candidates = [
            inputNode.inputFormat(forBus: 0),
            inputNode.outputFormat(forBus: 0),
        ]

        if let format = candidates.first(where: isValidRecordingFormat) {
            return format
        }

        throw VoiceControlError.invalidInputFormat
    }

    private func isValidRecordingFormat(_ format: AVAudioFormat) -> Bool {
        format.sampleRate > 0 && format.channelCount > 0
    }

    private func scheduleAutoSend(for transcript: String) {
        autoSendTask?.cancel()
        guard let client = connectedClient else {
            return
        }

        let trimmedTranscript = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        let wordCount = trimmedTranscript.split(whereSeparator: \.isWhitespace).count
        let silenceWindow = wordCount <= 2 ? shortCommandSilenceSeconds : autoSendSilenceSeconds

        autoSendTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(silenceWindow))
            guard let self else { return }
            guard self.isListening else { return }
            let latestTranscript = self.liveTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !latestTranscript.isEmpty else { return }
            guard latestTranscript == trimmedTranscript else { return }
            await self.stopListeningAndSend(client: client)
        }
    }

    private func normalizedProjectPath() -> String? {
        let rawPath = spatialSettings?.currentProjectPath.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !rawPath.isEmpty else {
            return nil
        }
        return rawPath
    }
}
