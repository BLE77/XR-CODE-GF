import SwiftUI

struct YukiARContentView: View {
    @EnvironmentObject private var client: YukiIOSClient
    @StateObject private var sceneModel = YukiARSceneModel()
    @State private var commandText = ""
    @State private var repoPath = ""

    var body: some View {
        ZStack {
            YukiARView(sceneModel: sceneModel, client: client)
                .ignoresSafeArea()

            VStack(spacing: 0) {
                topBar
                    .padding(.horizontal, 14)
                    .padding(.top, 10)

                Spacer()

                controlDock
                    .padding(.horizontal, 14)
                    .padding(.bottom, 18)
            }
        }
        .onOpenURL { url in
            if client.applyDeepLink(url) {
                sceneModel.requestPlaceInFront()
            }
        }
    }

    private var topBar: some View {
        HStack(spacing: 10) {
            Label(client.avatarPhase.title(agentName: client.agentName), systemImage: client.avatarPhase.symbolName)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(client.avatarPhase.tint)

            Spacer(minLength: 8)

            Text(client.statusText)
                .font(.caption)
                .lineLimit(1)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 8))
    }

    private var controlDock: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                TextField("Mac IP", text: $client.host)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.numbersAndPunctuation)
                    .textFieldStyle(.roundedBorder)

                TextField("Port", text: $client.port)
                    .keyboardType(.numberPad)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 78)

                Button {
                    client.isConnected ? client.disconnect() : client.connect()
                } label: {
                    Label(client.isConnected ? "Disconnect" : "Connect", systemImage: client.isConnected ? "bolt.slash" : "bolt")
                        .labelStyle(.iconOnly)
                }
                .buttonStyle(.borderedProminent)
                .accessibilityLabel(client.isConnected ? "Disconnect" : "Connect")
            }

            HStack(spacing: 8) {
                Button {
                    sceneModel.requestPlaceInFront()
                } label: {
                    Label("Place", systemImage: "arkit")
                }
                .buttonStyle(.bordered)

                Text(sceneModel.placementStatus)
                    .font(.caption)
                    .lineLimit(1)
                    .foregroundStyle(.secondary)

                Spacer(minLength: 0)
            }

            TextField("Tell Hermes what to do", text: $commandText, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...3)

            HStack(spacing: 8) {
                TextField("Repo path", text: $repoPath)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder)

                Button {
                    sendCommand()
                } label: {
                    Label("Send", systemImage: "paperplane.fill")
                }
                .buttonStyle(.borderedProminent)
                .disabled(commandText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 8))
    }

    private func sendCommand() {
        let text = commandText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            return
        }
        let repo = repoPath.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            if await client.sendTextCommand(text, repoPath: repo.isEmpty ? nil : repo) {
                commandText = ""
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
        case .alert: return "Needs You"
        case .ready: return "Ready"
        }
    }

    var symbolName: String {
        switch self {
        case .idle: return "sparkles"
        case .listening: return "mic.circle"
        case .thinking: return "hourglass"
        case .speaking: return "waveform"
        case .alert: return "exclamationmark.triangle"
        case .ready: return "checkmark.circle"
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
