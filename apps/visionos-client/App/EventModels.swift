import Foundation
import SwiftUI

struct AgentWireEvent: Identifiable, Decodable {
    let type: String
    let ts: String
    let session_id: String?
    let payload: [String: StringValue]

    var id: String {
        "\(ts)-\(type)-\(session_id ?? "none")"
    }
}

enum AssistantPhase {
    case idle
    case listening
    case thinking
    case speaking
    case success
    case alert

    var title: String {
        switch self {
        case .idle: return "Idle"
        case .listening: return "Listening"
        case .thinking: return "Working"
        case .speaking: return "Speaking"
        case .success: return "Ready"
        case .alert: return "Needs Attention"
        }
    }

    var symbolName: String {
        switch self {
        case .idle: return "sparkles"
        case .listening: return "mic.circle"
        case .thinking: return "hourglass.circle"
        case .speaking: return "waveform"
        case .success: return "checkmark.circle"
        case .alert: return "exclamationmark.triangle"
        }
    }

    var tint: Color {
        switch self {
        case .idle: return .teal
        case .listening: return .pink
        case .thinking: return .orange
        case .speaking: return .blue
        case .success: return .green
        case .alert: return .red
        }
    }

    var subtitle: String {
        switch self {
        case .idle: return "Hermes is standing by for your next coding task."
        case .listening: return "Listening for your next coding instruction."
        case .thinking: return "Hermes is running or tracking a task on your Mac."
        case .speaking: return "The assistant has an update ready for you."
        case .success: return "The last tracked task completed cleanly."
        case .alert: return "The latest task failed or needs your attention."
        }
    }
}

enum SessionSnapshotStatus {
    case running
    case finished
    case failed

    var title: String {
        switch self {
        case .running: return "Running"
        case .finished: return "Finished"
        case .failed: return "Failed"
        }
    }

    var tint: Color {
        switch self {
        case .running: return .orange
        case .finished: return .green
        case .failed: return .red
        }
    }
}

enum CodingSessionStatus {
    case running
    case closing
    case finished
    case failed

    var title: String {
        switch self {
        case .running: return "Live"
        case .closing: return "Closing"
        case .finished: return "Exited"
        case .failed: return "Failed"
        }
    }

    var tint: Color {
        switch self {
        case .running: return .blue
        case .closing: return .orange
        case .finished: return .green
        case .failed: return .red
        }
    }

    var sortRank: Int {
        switch self {
        case .running: return 0
        case .closing: return 1
        case .finished, .failed: return 2
        }
    }
}

struct SessionSnapshot: Identifiable {
    let id: String
    let title: String
    let repoPath: String?
    let command: String?
    let status: SessionSnapshotStatus
    let summary: String?
}

struct CodingSessionSnapshot: Identifiable {
    let id: String
    let title: String
    let repoPath: String?
    let command: String?
    let status: CodingSessionStatus
    let workerLabel: String?
    let taskTitle: String?
    let workerPhase: String?
    let statusText: String?
    let managerSummary: String?
    let waitingOnUser: Bool
    let needsReview: Bool
    let blockedReason: String?
    let pendingQuestion: String?
    let lastUpdate: String?
    let outputTail: [String]
    let screenText: String?
    let screenRows: Int?
    let screenColumns: Int?
    let logPath: String?
}

extension AgentWireEvent {
    var parsedDate: Date? {
        Self.iso8601Formatter.date(from: ts) ?? Self.iso8601FallbackFormatter.date(from: ts)
    }

    func payloadText(_ key: String) -> String? {
        payload[key]?.displayText
    }

    func payloadInt(_ key: String) -> Int? {
        guard let value = payload[key] else {
            return nil
        }
        switch value {
        case .int(let number):
            return number
        case .string(let text):
            return Int(text)
        default:
            return Int(value.displayText)
        }
    }

    func payloadBool(_ key: String) -> Bool? {
        guard let value = payload[key] else {
            return nil
        }
        switch value {
        case .bool(let boolValue):
            return boolValue
        case .string(let text):
            return ["true", "1", "yes"].contains(text.lowercased())
        case .int(let number):
            return number != 0
        default:
            return nil
        }
    }

    var timestampLabel: String {
        guard let date = parsedDate else {
            return ts
        }

        let display = DateFormatter()
        display.timeStyle = .short
        display.dateStyle = .none
        return display.string(from: date)
    }

    private static let iso8601Formatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let iso8601FallbackFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    var headline: String {
        switch type {
        case "speech.transcript":
            return "Voice command"
        case "avatar.thinking":
            return "Hermes started working"
        case "avatar.speaking":
            return "Hermes is speaking"
        case "assistant.reply":
            return "Hermes replied"
        case "hermes.status":
            return "Hermes update"
        case "project.selected":
            return "Project selected"
        case "worker.updated":
            return "Worker update"
        case "worker.pending_question":
            return "Worker needs you"
        case "session.started":
            return "Tracked task started"
        case "terminal.started":
            return "Opened coding session"
        case "terminal.input":
            return "Sent input"
        case "terminal.output":
            return "Coding session output"
        case "terminal.screen":
            return "Coding session screen"
        case "terminal.finished":
            return "Coding session finished"
        case "terminal.failed":
            return "Coding session failed"
        case "session.output":
            return "Task output"
        case "session.finished":
            return "Task finished"
        case "session.failed":
            return "Task failed"
        case "agent.summary":
            return "Summary"
        default:
            return type.replacingOccurrences(of: ".", with: " ").capitalized
        }
    }

    var detail: String? {
        switch type {
        case "speech.transcript", "avatar.speaking", "assistant.reply", "agent.summary", "hermes.status":
            return payloadText("text")
        case "project.selected":
            return payloadText("path")
        case "worker.updated":
            return payloadText("manager_summary") ?? payloadText("last_update") ?? payloadText("status_text")
        case "worker.pending_question":
            return payloadText("question")
        case "session.started", "terminal.started":
            return payloadText("title")
        case "terminal.input":
            return payloadText("text")
        case "terminal.screen":
            return terminalScreenPreview()
        case "terminal.output":
            return payloadText("line")
        case "terminal.finished", "terminal.failed":
            return payloadText("summary")
        case "session.finished", "session.failed":
            return payloadText("summary")
        case "session.output":
            return payloadText("line")
        default:
            return nil
        }
    }

    private func terminalScreenPreview(limit: Int = 160) -> String? {
        let value = payloadText("screen_text")
            ?? payloadText("screenText")
            ?? payloadText("text")
        guard let value else {
            return nil
        }

        let flattened = value.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !flattened.isEmpty else {
            return nil
        }
        if flattened.count <= limit {
            return flattened
        }
        return String(flattened.prefix(limit - 1)).trimmingCharacters(in: .whitespacesAndNewlines) + "…"
    }
}

enum StringValue: Decodable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case object([String: StringValue])
    case array([StringValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode(Int.self) {
            self = .int(value)
        } else if let value = try? container.decode(Double.self) {
            self = .double(value)
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode([String: StringValue].self) {
            self = .object(value)
        } else if let value = try? container.decode([StringValue].self) {
            self = .array(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }

    var displayText: String {
        switch self {
        case .string(let value): return value
        case .int(let value): return String(value)
        case .double(let value): return String(value)
        case .bool(let value): return String(value)
        case .object(let value): return value.map { "\($0.key): \($0.value.displayText)" }.joined(separator: ", ")
        case .array(let value): return value.map(\.displayText).joined(separator: ", ")
        case .null: return "null"
        }
    }
}
