import SwiftUI

struct EventFeedView: View {
    @ObservedObject var client: EventStreamClient
    @State private var displayLimit = 8

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Signal Feed")
                        .font(.headline)
                    Text("High-signal updates from Hermes and the workers.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(client.statusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if client.events.isEmpty {
                ContentUnavailableView(
                    "No activity yet",
                    systemImage: "dot.radiowaves.left.and.right",
                    description: Text("Start the Mac companion, then ask Hermes to open a worker or run a tracked command.")
                )
                .frame(maxWidth: .infinity, minHeight: 180)
            } else if displayEvents.isEmpty {
                ContentUnavailableView(
                    "Quiet for now",
                    systemImage: "sparkles",
                    description: Text("Hermes is connected, but there are no high-signal updates to show yet.")
                )
                .frame(maxWidth: .infinity, minHeight: 180)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(displayEvents.prefix(displayLimit)) { event in
                            EventFeedRow(event: event)
                        }
                    }
                }
                .frame(minHeight: 220)

                if displayEvents.count > displayLimit {
                    Button("Show More Updates") {
                        displayLimit += 8
                    }
                    .buttonStyle(.bordered)
                }
            }
        }
        .padding()
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24))
    }

    private var displayEvents: [AgentWireEvent] {
        client.signalEvents
    }
}

private struct EventFeedRow: View {
    let event: AgentWireEvent

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Text(event.badgeLabel)
                    .font(.caption2)
                    .fontWeight(.semibold)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(event.accentColor.opacity(0.14), in: Capsule())
                    .foregroundStyle(event.accentColor)

                VStack(alignment: .leading, spacing: 4) {
                    Text(event.headline)
                        .font(.subheadline)
                        .fontWeight(.semibold)

                    if let detail = event.detail, !detail.isEmpty {
                        Text(detail)
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                    }
                }

                Spacer()

                Text(event.timestampLabel)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }

            if let repoPath = event.payloadText("repo_path"), !repoPath.isEmpty {
                Text(repoPath)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            if let command = event.payloadText("command"), !command.isEmpty {
                Text(command)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18))
        .overlay(
            RoundedRectangle(cornerRadius: 18)
                .strokeBorder(event.accentColor.opacity(0.16), lineWidth: 1)
        )
    }
}

private extension AgentWireEvent {
    var badgeLabel: String {
        switch type {
        case "assistant.reply", "hermes.status":
            return "Hermes"
        case "worker.updated", "worker.pending_question":
            return "Worker"
        case "session.started", "session.finished", "session.failed", "terminal.started", "terminal.input", "terminal.finished", "terminal.failed":
            return "Session"
        case "project.selected":
            return "Project"
        default:
            return "Update"
        }
    }

    var accentColor: Color {
        switch type {
        case "assistant.reply", "hermes.status":
            return .blue
        case "worker.updated", "worker.pending_question":
            return .orange
        case "session.finished":
            return .green
        case "session.failed", "terminal.failed":
            return .red
        case "project.selected":
            return .teal
        default:
            return .secondary
        }
    }
}

#Preview {
    EventFeedView(client: EventStreamClient())
}
