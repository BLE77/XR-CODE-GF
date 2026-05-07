import base64

from xr_agent.speech_service import SpeechService


def test_synthesize_uses_elevenlabs_streaming_endpoint_by_default(monkeypatch) -> None:
    service = SpeechService(api_key="test-key", voice_id="voice-123", voice_name="Yuki")
    requests = []

    def fake_request_binary(method, url, payload, *, accept):
        requests.append(
            {
                "method": method,
                "url": url,
                "payload": payload,
                "accept": accept,
            }
        )
        return b"fake-mp3"

    monkeypatch.setattr(service, "_request_binary", fake_request_binary)

    result = service.synthesize(" Hello from Yuki. ")

    assert result.provider == "elevenlabs"
    assert result.voice_id == "voice-123"
    assert result.voice_name == "Yuki"
    assert result.model_id == "eleven_flash_v2_5"
    assert result.transport == "http-stream"
    assert result.latency_mode == "low-latency"
    assert result.audio_mime_type == "audio/mpeg"
    assert result.audio_base64 == base64.b64encode(b"fake-mp3").decode("ascii")
    assert result.audio_byte_count == len(b"fake-mp3")
    assert requests == [
        {
            "method": "POST",
            "url": "https://api.elevenlabs.io/v1/text-to-speech/voice-123/stream?output_format=mp3_22050_32",
            "payload": {
                "text": "Hello from Yuki.",
                "model_id": "eleven_flash_v2_5",
            },
            "accept": "audio/mpeg",
        }
    ]


def test_synthesize_can_use_timestamp_endpoint_for_alignment(monkeypatch) -> None:
    service = SpeechService(
        api_key="test-key",
        voice_id="voice-123",
        output_format="mp3_44100_128",
        tts_mode="timestamps",
    )
    requests = []

    def fake_request_json(method, url, payload=None):
        requests.append({"method": method, "url": url, "payload": payload})
        return {
            "audio_base64": base64.b64encode(b"fake-mp3").decode("ascii"),
            "normalized_alignment": {
                "characters": ["h", "i"],
                "character_end_times_seconds": [0.1, 0.35],
            },
        }

    monkeypatch.setattr(service, "_request_json", fake_request_json)

    result = service.synthesize("hi")

    assert result.transport == "with-timestamps"
    assert result.latency_mode == "alignment"
    assert result.duration_ms == 800
    assert result.audio_byte_count == len(b"fake-mp3")
    assert requests == [
        {
            "method": "POST",
            "url": "https://api.elevenlabs.io/v1/text-to-speech/voice-123/with-timestamps?output_format=mp3_44100_128",
            "payload": {
                "text": "hi",
                "model_id": "eleven_flash_v2_5",
            },
        }
    ]


def test_synthesize_can_use_openai_speech_endpoint(monkeypatch) -> None:
    service = SpeechService(
        provider="openai",
        openai_api_key="test-key",
        openai_model_id="gpt-4o-mini-tts",
        openai_voice="marin",
        openai_instructions="Speak like Hermes.",
    )
    requests = []

    def fake_request_openai_binary(method, url, payload, *, accept, api_key):
        requests.append(
            {
                "method": method,
                "url": url,
                "payload": payload,
                "accept": accept,
                "api_key": api_key,
            }
        )
        return b"fake-openai-mp3"

    monkeypatch.setattr(service, "_request_openai_binary", fake_request_openai_binary)

    result = service.synthesize(" Route this quickly. ")

    assert result.provider == "openai"
    assert result.voice_id == "marin"
    assert result.voice_name == "marin"
    assert result.model_id == "gpt-4o-mini-tts"
    assert result.transport == "audio-speech"
    assert result.latency_mode == "streaming-response"
    assert result.audio_mime_type == "audio/mpeg"
    assert result.audio_base64 == base64.b64encode(b"fake-openai-mp3").decode("ascii")
    assert requests == [
        {
            "method": "POST",
            "url": "https://api.openai.com/v1/audio/speech",
            "payload": {
                "model": "gpt-4o-mini-tts",
                "voice": "marin",
                "input": "Route this quickly.",
                "response_format": "mp3",
                "instructions": "Speak like Hermes.",
            },
            "accept": "audio/mpeg",
            "api_key": "test-key",
        }
    ]


def test_transcribe_audio_can_use_openai_provider(monkeypatch) -> None:
    service = SpeechService(provider="openai", openai_api_key="test-key")
    requests = []

    def fake_request_openai_multipart_json(method, url, *, fields, file_field, api_key):
        requests.append(
            {
                "method": method,
                "url": url,
                "fields": fields,
                "file_field": file_field,
                "api_key": api_key,
            }
        )
        return {"text": "move the panels"}

    monkeypatch.setattr(service, "_request_openai_multipart_json", fake_request_openai_multipart_json)

    result = service.transcribe_audio(b"fake-webm", mime_type="audio/webm")

    assert result == "move the panels"
    assert requests == [
        {
            "method": "POST",
            "url": "https://api.openai.com/v1/audio/transcriptions",
            "fields": [("model", "gpt-4o-mini-transcribe")],
            "file_field": ("file", "quest-mic.webm", "audio/webm", b"fake-webm"),
            "api_key": "test-key",
        }
    ]
