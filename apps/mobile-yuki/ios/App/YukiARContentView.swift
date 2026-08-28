import SwiftUI

struct YukiARContentView: View {
    @EnvironmentObject private var client: YukiIOSClient
    @StateObject private var sceneModel = YukiARSceneModel()
    @State private var commandText = ""
    @State private var repoPath = ""
    @State private var showCommandSheet = false
    @State private var showSettings = false

    var body: some View {
        ZStack {
            YukiARView(sceneModel: sceneModel, client: client)
                .ignoresSafeArea()

            VStack(spacing: 0) {
                topStatusPill
                    .padding(.horizontal, 16)
                    .padding(.top, 8)

                Spacer()

                if let previewText {
                    conversationPreview(previewText)
                        .padding(.horizontal, 20)
                        .padding(.bottom, 10)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }

                controlIsland
                    .padding(.horizontal, 16)
                    .padding(.bottom, 10)
            }
        }
        .animation(.easeInOut(duration: 0.22), value: previewText)
        .onOpenURL { url in
            if client.applyDeepLink(url) {
                sceneModel.requestPlaceInFront()
            }
        }
        .sheet(isPresented: $showCommandSheet) {
            commandSheet
        }
        .sheet(isPresented: $showSettings) {
            settingsSheet
        }
    }

    private var topStatusPill: some View {
        HStack(spacing: 10) {
            Image(systemName: client.avatarPhase.symbolName)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(client.avatarPhase.tint)
                .frame(width: 30, height: 30)
                .background(client.avatarPhase.tint.opacity(0.15), in: Circle())

            VStack(alignment: .leading, spacing: 1) {
                Text(client.avatarPhase.title(agentName: client.agentName))
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(sceneModel.placementStatus)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            HStack(spacing: 5) {
                Circle()
                    .fill(client.isRealtimeConnected ? Color.green : Color.orange)
                    .frame(width: 7, height: 7)
                Text(client.isRealtimeConnected ? "Live" : "Offline")
                    .font(.caption.weight(.medium))
            }
            .foregroundStyle(.secondary)

            Button {
                showSettings = true
            } label: {
                Image(systemName: "gearshape.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .frame(width: 32, height: 32)
                    .background(.white.opacity(0.1), in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Connection settings")
        }
        .padding(.leading, 8)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .foregroundStyle(.primary)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().stroke(.white.opacity(0.14), lineWidth: 0.5))
    }

    private var controlIsland: some View {
        VStack(spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: sceneModel.placementStatus.lowercased().contains("found") ? "checkmark.circle.fill" : "viewfinder.circle")
                    .foregroundStyle(sceneModel.placementStatus.lowercased().contains("found") ? .green : .cyan)
                Text(sceneModel.placementStatus)
                    .font(.caption.weight(.medium))
                    .lineLimit(1)
                Spacer()
                Text(client.realtimeStatus)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            HStack(alignment: .center, spacing: 14) {
                roundControl(
                    title: "Place",
                    systemImage: "arkit",
                    tint: .cyan,
                    size: 52
                ) {
                    sceneModel.requestPlaceInFront()
                }

                voiceControl

                roundControl(
                    title: client.isMicrophoneMuted ? "Unmute" : "Mute",
                    systemImage: client.isMicrophoneMuted ? "mic.slash.fill" : "mic.fill",
                    tint: client.isMicrophoneMuted ? .red : .green,
                    size: 52
                ) {
                    client.toggleMicrophoneMute()
                }
                .disabled(!client.isRealtimeConnected)
                .opacity(client.isRealtimeConnected ? 1 : 0.45)
                .accessibilityLabel(client.isMicrophoneMuted ? "Unmute microphone" : "Mute microphone")

                if client.avatarPhase == .speaking {
                    roundControl(
                        title: "Interrupt",
                        systemImage: "stop.fill",
                        tint: .red,
                        size: 52
                    ) {
                        client.cancelRealtimeReply()
                    }
                } else {
                    roundControl(
                        title: "Command",
                        systemImage: "text.bubble.fill",
                        tint: .purple,
                        size: 52
                    ) {
                        showCommandSheet = true
                    }
                }
            }
            .frame(maxWidth: .infinity)
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 14)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .stroke(.white.opacity(0.16), lineWidth: 0.5)
        )
        .shadow(color: .black.opacity(0.18), radius: 18, y: 8)
    }

    private var voiceControl: some View {
        Button {
            client.toggleRealtime()
        } label: {
            VStack(spacing: 6) {
                ZStack {
                    Circle()
                        .fill(client.isRealtimeConnected ? Color.blue.gradient : Color.white.opacity(0.14).gradient)
                        .frame(width: 68, height: 68)
                        .shadow(color: client.isRealtimeConnected ? .blue.opacity(0.35) : .clear, radius: 12)
                    Image(systemName: client.isRealtimeConnected ? "waveform" : "mic.fill")
                        .font(.system(size: 25, weight: .semibold))
                        .foregroundStyle(.white)
                }
                Text(client.isRealtimeConnected ? "Live voice" : "Start voice")
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(client.isRealtimeConnected ? "Stop live voice" : "Start live voice")
    }

    private func roundControl(
        title: String,
        systemImage: String,
        tint: Color,
        size: CGFloat,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(tint)
                    .frame(width: size, height: size)
                    .background(.white.opacity(0.1), in: Circle())
                Text(title)
                    .font(.caption2.weight(.medium))
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
            }
        }
        .buttonStyle(.plain)
    }

    private func conversationPreview(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: client.avatarPhase == .listening ? "person.wave.2.fill" : "sparkles")
                .foregroundStyle(client.avatarPhase == .listening ? .pink : .cyan)
            Text(text)
                .font(.subheadline)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                showCommandSheet = true
            } label: {
                Image(systemName: "arrow.up.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(.white.opacity(0.12), lineWidth: 0.5)
        )
    }

    private var commandSheet: some View {
        NavigationStack {
            Form {
                Section("Ask Hermy") {
                    TextField("What should Hermy do?", text: $commandText, axis: .vertical)
                        .lineLimit(3...7)
                }

                Section {
                    DisclosureGroup("Advanced") {
                        TextField("Optional repository path", text: $repoPath)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                }

                Section {
                    Button {
                        sendCommand()
                    } label: {
                        Label("Send to Hermy", systemImage: "paperplane.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .disabled(commandText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .navigationTitle("Command")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { showCommandSheet = false }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private var settingsSheet: some View {
        NavigationStack {
            Form {
                Section("Connection") {
                    LabeledContent("Mac host") {
                        TextField("Host", text: $client.host)
                            .multilineTextAlignment(.trailing)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    LabeledContent("Events port") {
                        TextField("Port", text: $client.port)
                            .multilineTextAlignment(.trailing)
                            .keyboardType(.numberPad)
                    }
                    LabeledContent("Voice port") {
                        TextField("Port", text: $client.realtimePort)
                            .multilineTextAlignment(.trailing)
                            .keyboardType(.numberPad)
                    }
                }

                Section("Status") {
                    LabeledContent("Events", value: client.statusText)
                    LabeledContent("Voice", value: client.realtimeStatus)
                    LabeledContent("Microphone", value: client.isMicrophoneMuted ? "Muted" : "On")
                }

                Section {
                    Button {
                        client.isConnected ? client.disconnect() : client.connect()
                    } label: {
                        Label(
                            client.isConnected ? "Disconnect event stream" : "Connect event stream",
                            systemImage: client.isConnected ? "bolt.slash.fill" : "bolt.fill"
                        )
                    }

                    Button {
                        client.toggleRealtime()
                    } label: {
                        Label(
                            client.isRealtimeConnected ? "Stop live voice" : "Start live voice",
                            systemImage: client.isRealtimeConnected ? "waveform.slash" : "waveform"
                        )
                    }
                }
            }
            .navigationTitle("Mobile Yuki")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { showSettings = false }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private var previewText: String? {
        if client.avatarPhase == .listening, let transcript = client.latestTranscript, !transcript.isEmpty {
            return transcript
        }
        if let reply = client.latestReply, !reply.isEmpty {
            return reply
        }
        return nil
    }

    private func sendCommand() {
        let text = commandText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let repo = repoPath.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            if await client.sendTextCommand(text, repoPath: repo.isEmpty ? nil : repo) {
                commandText = ""
                showCommandSheet = false
            }
        }
    }
}

private extension YukiAvatarPhase {
    func title(agentName: String) -> String {
        switch self {
        case .idle: return agentName.capitalized
        case .listening: return "Listening"
        case .thinking: return "Thinking"
        case .speaking: return "Speaking"
        case .alert: return "Needs you"
        case .ready: return "Ready"
        }
    }

    var symbolName: String {
        switch self {
        case .idle: return "sparkles"
        case .listening: return "mic.circle.fill"
        case .thinking: return "hourglass"
        case .speaking: return "waveform"
        case .alert: return "exclamationmark.triangle.fill"
        case .ready: return "checkmark.circle.fill"
        }
    }

    var tint: Color {
        switch self {
        case .idle: return .cyan
        case .listening: return .pink
        case .thinking: return .orange
        case .speaking: return .blue
        case .alert: return .red
        case .ready: return .green
        }
    }
}
