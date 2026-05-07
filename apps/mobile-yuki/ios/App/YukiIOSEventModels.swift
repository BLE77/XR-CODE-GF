import Foundation

struct AgentWireEvent: Identifiable, Decodable {
    let type: String
    let ts: String
    let sessionID: String?
    let payload: [String: WireValue]

    var id: String {
        "\(ts)-\(type)-\(sessionID ?? "none")"
    }

    enum CodingKeys: String, CodingKey {
        case type
        case ts
        case sessionID = "session_id"
        case payload
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
        case .double(let number):
            return Int(number)
        case .string(let text):
            return Int(text)
        case .bool(let bool):
            return bool ? 1 : 0
        default:
            return nil
        }
    }
}

enum WireValue: Decodable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case object([String: WireValue])
    case array([WireValue])
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
        } else if let value = try? container.decode([String: WireValue].self) {
            self = .object(value)
        } else if let value = try? container.decode([WireValue].self) {
            self = .array(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsupported JSON value"
            )
        }
    }

    var displayText: String {
        switch self {
        case .string(let value):
            return value
        case .int(let value):
            return String(value)
        case .double(let value):
            return String(value)
        case .bool(let value):
            return String(value)
        case .object(let value):
            return value
                .map { "\($0.key): \($0.value.displayText)" }
                .joined(separator: ", ")
        case .array(let value):
            return value.map(\.displayText).joined(separator: ", ")
        case .null:
            return "null"
        }
    }
}
