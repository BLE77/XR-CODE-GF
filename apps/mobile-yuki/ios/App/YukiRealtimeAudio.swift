import AVFoundation
import Foundation

@MainActor
final class YukiRealtimeAudioController {
    enum State: Equatable {
        case disconnected
        case connecting
        case authenticated
        case ready
        case listening
        case speaking
        case reconnecting
        case failed
    }

    var onState: ((State, String?) -> Void)?
    var onTranscript: ((String, Bool, Bool) -> Void)?

    private let audioEngine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 48_000,
        channels: 1,
        interleaved: false
    )!
    private let playbackFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: 48_000,
        channels: 1,
        interleaved: false
    )!
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var shouldReconnect = false
    private var reconnectAttempt = 0
    private var connection: Connection?
    private var microphoneMuted = false
    private var noiseGateHangoverFrames = 0

    // 20 ms packets: keep the gate open briefly between syllables.
    private let noiseGateHangoverPacketCount = 30
    private let noiseGateRMS: Double = 0.010
    private let noiseGatePeak: Double = 0.025

    private struct Connection {
        let host: String
        let port: Int
        let scheme: String
        let token: String
    }

    init() {
        audioEngine.attach(player)
        audioEngine.connect(player, to: audioEngine.mainMixerNode, format: playbackFormat)
    }

    func connect(host: String, port: Int, scheme: String, token: String) {
        disconnect(reconnect: false)
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty, !trimmedToken.isEmpty else {
            onState?(.failed, "Realtime QR is missing its Mac host or pairing token")
            return
        }
        let next = Connection(host: host, port: port, scheme: scheme == "wss" ? "wss" : "ws", token: trimmedToken)
        connection = next
        shouldReconnect = true
        open(next)
    }

    func disconnect(reconnect: Bool = false) {
        shouldReconnect = reconnect
        receiveTask?.cancel()
        receiveTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        stopAudio()
        if !reconnect {
            connection = nil
            reconnectAttempt = 0
            onState?(.disconnected, nil)
        }
    }

    func cancelResponse() {
        guard let socket else { return }
        let payload = URLSessionWebSocketTask.Message.string("{\"type\":\"mobile.realtime.cancel\"}")
        socket.send(payload) { _ in }
        clearPlayback()
    }

    func setMicrophoneMuted(_ muted: Bool) {
        microphoneMuted = muted
        noiseGateHangoverFrames = 0
    }

    @discardableResult
    func sendTextCommand(_ text: String) -> Bool {
        guard let socket else { return false }
        guard let data = try? JSONSerialization.data(withJSONObject: [
            "type": "mobile.text_command",
            "text": text,
        ]), let payload = String(data: data, encoding: .utf8) else { return false }
        socket.send(.string(payload)) { _ in }
        return true
    }

    private func open(_ connection: Connection) {
        var components = URLComponents()
        components.scheme = connection.scheme
        components.host = connection.host
        components.port = connection.port
        components.path = "/realtime"
        guard let url = components.url else {
            onState?(.failed, "Could not build the Mobile Yuki Realtime URL")
            return
        }

        onState?(.connecting, "Connecting live voice to the Mac")
        var request = URLRequest(url: url)
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let task = URLSession(configuration: .ephemeral).webSocketTask(with: request)
        socket = task
        task.resume()
        do {
            try startAudio()
        } catch {
            onState?(.failed, "Audio start failed: \(error.localizedDescription)")
            task.cancel(with: .internalServerError, reason: nil)
            return
        }
        receiveTask = Task { [weak self] in
            await self?.receiveLoop(task)
        }
    }

    private func receiveLoop(_ task: URLSessionWebSocketTask) async {
        do {
            while !Task.isCancelled {
                let message = try await task.receive()
                switch message {
                case .data(let data):
                    receiveAudio(data)
                case .string(let text):
                    receiveControl(text)
                @unknown default:
                    break
                }
            }
        } catch {
            guard socket === task else { return }
            socket = nil
            stopAudio()
            if shouldReconnect, let connection {
                reconnectAttempt += 1
                onState?(.reconnecting, "Live voice reconnecting")
                let delay = min(5.0, Double(reconnectAttempt))
                try? await Task.sleep(for: .seconds(delay))
                guard shouldReconnect, !Task.isCancelled else { return }
                open(connection)
            } else {
                onState?(.disconnected, error.localizedDescription)
            }
        }
    }

    private func receiveControl(_ text: String) {
        guard
            let data = text.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let type = object["type"] as? String
        else { return }

        switch type {
        case "mobile.realtime.authenticated":
            reconnectAttempt = 0
            onState?(.authenticated, "Secure live voice connected")
        case "mobile.realtime.ready":
            onState?(.ready, "Mobile Yuki is live")
        case "mobile.realtime.reconnecting":
            onState?(.reconnecting, "Hermy is refreshing the Realtime session")
        case "mobile.realtime.error":
            onState?(.failed, object["detail"] as? String)
        case "mobile.provider_event":
            handleProviderEvent(object)
        default:
            break
        }
    }

    private func handleProviderEvent(_ object: [String: Any]) {
        let providerType = object["provider_type"] as? String ?? ""
        switch providerType {
        case "input_audio_buffer.speech_started":
            clearPlayback()
            onState?(.listening, "Listening")
        case "input_audio_buffer.speech_stopped":
            onState?(.ready, "Thinking")
        case "response.output_audio_transcript.delta":
            if let delta = object["delta"] as? String, !delta.isEmpty {
                onTranscript?(delta, false, false)
            }
        case "response.output_audio_transcript.done":
            if let transcript = object["transcript"] as? String, !transcript.isEmpty {
                onTranscript?(transcript, true, false)
            }
        case "conversation.item.input_audio_transcription.completed":
            if let transcript = object["transcript"] as? String, !transcript.isEmpty {
                onTranscript?(transcript, true, true)
            }
        case "error":
            onState?(.failed, object["detail"] as? String)
        default:
            break
        }
    }

    private func startAudio() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.defaultToSpeaker, .allowBluetoothHFP]
        )
        try session.setPreferredSampleRate(48_000)
        try session.setPreferredIOBufferDuration(0.02)
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        let input = audioEngine.inputNode
        try input.setVoiceProcessingEnabled(true)
        let sourceFormat = input.outputFormat(forBus: 0)
        guard let converter = AVAudioConverter(from: sourceFormat, to: targetFormat) else {
            throw NSError(domain: "MobileYukiRealtime", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unsupported microphone format"])
        }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 960, format: sourceFormat) { [weak self] buffer, _ in
            guard let self else { return }
            let ratio = self.targetFormat.sampleRate / sourceFormat.sampleRate
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 8
            guard let converted = AVAudioPCMBuffer(pcmFormat: self.targetFormat, frameCapacity: capacity) else { return }
            var supplied = false
            var conversionError: NSError?
            converter.convert(to: converted, error: &conversionError) { _, status in
                if supplied {
                    status.pointee = .noDataNow
                    return nil
                }
                supplied = true
                status.pointee = .haveData
                return buffer
            }
            guard conversionError == nil, converted.frameLength > 0, let channel = converted.int16ChannelData?[0] else { return }
            let pcm = Data(bytes: channel, count: Int(converted.frameLength) * MemoryLayout<Int16>.size)
            Task { @MainActor [weak self] in
                self?.sendMicrophonePCM(pcm)
            }
        }
        audioEngine.prepare()
        try audioEngine.start()
        if !player.isPlaying {
            player.play()
        }
    }

    private func stopAudio() {
        if audioEngine.isRunning {
            audioEngine.inputNode.removeTap(onBus: 0)
            audioEngine.stop()
        }
        clearPlayback()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func sendMicrophonePCM(_ pcm: Data) {
        guard let socket, !pcm.isEmpty else { return }
        let outgoing: Data
        if microphoneMuted {
            outgoing = Data(repeating: 0, count: pcm.count)
        } else if shouldPassNoiseGate(pcm) {
            outgoing = pcm
        } else {
            outgoing = Data(repeating: 0, count: pcm.count)
        }
        var packet = Data([0x01])
        packet.append(outgoing)
        socket.send(.data(packet)) { _ in }
    }

    private func shouldPassNoiseGate(_ pcm: Data) -> Bool {
        var sumSquares = 0.0
        var peak = 0.0
        var sampleCount = 0
        pcm.withUnsafeBytes { raw in
            for sample in raw.bindMemory(to: Int16.self) {
                let normalized = Double(Int16(littleEndian: sample)) / 32_768.0
                peak = max(peak, abs(normalized))
                sumSquares += normalized * normalized
                sampleCount += 1
            }
        }
        guard sampleCount > 0 else { return false }
        let rms = sqrt(sumSquares / Double(sampleCount))
        if rms >= noiseGateRMS || peak >= noiseGatePeak {
            noiseGateHangoverFrames = noiseGateHangoverPacketCount
            return true
        }
        if noiseGateHangoverFrames > 0 {
            noiseGateHangoverFrames -= 1
            return true
        }
        return false
    }

    private func receiveAudio(_ data: Data) {
        guard data.first == 0x02, data.count > 1 else { return }
        let pcm = data.dropFirst()
        let frameCount = AVAudioFrameCount(pcm.count / MemoryLayout<Int16>.size)
        guard frameCount > 0, let buffer = AVAudioPCMBuffer(pcmFormat: playbackFormat, frameCapacity: frameCount) else { return }
        buffer.frameLength = frameCount
        guard let destination = buffer.floatChannelData?[0] else { return }
        pcm.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            for index in 0..<Int(frameCount) {
                destination[index] = Float(Int16(littleEndian: samples[index])) / 32_768.0
            }
        }
        if !audioEngine.isRunning {
            try? audioEngine.start()
        }
        if !player.isPlaying {
            player.play()
        }
        player.scheduleBuffer(buffer)
        onState?(.speaking, "Speaking")
    }

    private func clearPlayback() {
        player.stop()
        player.reset()
        if audioEngine.isRunning {
            player.play()
        }
    }
}
