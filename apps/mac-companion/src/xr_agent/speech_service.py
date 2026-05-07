from __future__ import annotations

import base64
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any


@dataclass
class SpeechSynthesisResult:
    text: str
    duration_ms: int | None = None
    audio_base64: str | None = None
    audio_mime_type: str | None = None
    alignment: dict[str, list[Any]] | None = None
    normalized_alignment: dict[str, list[Any]] | None = None
    provider: str = "plain"
    voice_id: str | None = None
    voice_name: str | None = None
    model_id: str | None = None
    transport: str | None = None
    latency_mode: str | None = None
    synthesis_ms: int | None = None
    audio_byte_count: int | None = None


class SpeechService:
    def __init__(
        self,
        *,
        provider: str = "elevenlabs",
        api_key: str | None = None,
        voice_id: str | None = None,
        voice_name: str | None = None,
        model_id: str = "eleven_flash_v2_5",
        output_format: str = "mp3_22050_32",
        tts_mode: str = "streaming",
        stt_api_key: str | None = None,
        stt_model_id: str = "scribe_v2",
        openai_api_key: str | None = None,
        openai_model_id: str = "gpt-4o-mini-tts",
        openai_voice: str = "coral",
        openai_output_format: str = "mp3",
        openai_instructions: str | None = None,
        openai_stt_api_key: str | None = None,
        openai_stt_model_id: str = "gpt-4o-mini-transcribe",
        timeout_seconds: float = 20.0,
    ) -> None:
        normalized_provider = (provider or "elevenlabs").strip().lower()
        self.provider = normalized_provider if normalized_provider in {"elevenlabs", "openai"} else "elevenlabs"
        self.api_key = api_key.strip() if api_key else None
        self.voice_id = voice_id.strip() if voice_id else None
        self.voice_name = voice_name.strip() if voice_name else None
        self.model_id = model_id.strip() if model_id else "eleven_flash_v2_5"
        self.output_format = output_format.strip() if output_format else "mp3_22050_32"
        normalized_tts_mode = (tts_mode or "streaming").strip().lower()
        self.tts_mode = normalized_tts_mode if normalized_tts_mode in {"streaming", "timestamps"} else "streaming"
        self.stt_api_key = stt_api_key.strip() if stt_api_key else self.api_key
        self.stt_model_id = stt_model_id.strip() if stt_model_id else "scribe_v2"
        self.openai_api_key = openai_api_key.strip() if openai_api_key else None
        self.openai_model_id = openai_model_id.strip() if openai_model_id else "gpt-4o-mini-tts"
        self.openai_voice = openai_voice.strip() if openai_voice else "coral"
        self.openai_output_format = openai_output_format.strip() if openai_output_format else "mp3"
        self.openai_instructions = openai_instructions.strip() if openai_instructions else None
        self.openai_stt_api_key = openai_stt_api_key.strip() if openai_stt_api_key else self.openai_api_key
        self.openai_stt_model_id = openai_stt_model_id.strip() if openai_stt_model_id else "gpt-4o-mini-transcribe"
        self.timeout_seconds = max(3.0, timeout_seconds)
        self._resolved_voice: tuple[str | None, str | None] | None = None
        self._warned_messages: set[str] = set()

    def transcribe(self, text: str) -> str:
        return text

    def speak(self, text: str) -> str:
        return self.synthesize(text).text

    def transcribe_audio(self, audio: bytes, *, mime_type: str | None = None) -> str:
        if not audio:
            return ""
        if self.provider == "openai":
            if not self.openai_stt_api_key:
                raise RuntimeError("Speech-to-text is not configured. Set OPENAI_API_KEY.")
            return self._transcribe_audio_openai(audio, mime_type=mime_type)
        if not self.stt_api_key:
            raise RuntimeError("Speech-to-text is not configured. Set ELEVENLABS_API_KEY.")

        response = self._request_multipart_json(
            "POST",
            "https://api.elevenlabs.io/v1/speech-to-text",
            fields=[
                ("model_id", self.stt_model_id),
                ("tag_audio_events", "false"),
                ("diarize", "false"),
            ],
            file_field=(
                "file",
                self._filename_for_mime_type(mime_type),
                mime_type or "audio/webm",
                audio,
            ),
            api_key=self.stt_api_key,
        )
        transcript = response.get("text")
        if not isinstance(transcript, str):
            raise RuntimeError("Speech-to-text returned no transcript.")
        return transcript.strip()

    def synthesize(self, text: str) -> SpeechSynthesisResult:
        spoken = text.strip() or text
        result = SpeechSynthesisResult(text=spoken)
        if not spoken:
            return result

        if self.provider == "openai":
            if not self.openai_api_key:
                return result
            try:
                return self._synthesize_openai(spoken)
            except Exception as exc:  # pragma: no cover - depends on live network/service
                self._warn_once(f"OpenAI synthesis unavailable: {exc}")
                return result

        if not self.api_key:
            return result

        try:
            voice_id, voice_name = self._resolve_voice()
            if not voice_id:
                self._warn_once("ElevenLabs voice resolution failed; falling back to text-only replies.")
                return result

            if self.tts_mode == "timestamps":
                return self._synthesize_with_timestamps(spoken, voice_id, voice_name)
            return self._synthesize_streaming(spoken, voice_id, voice_name)
        except Exception as exc:  # pragma: no cover - depends on live network/service
            self._warn_once(f"ElevenLabs synthesis unavailable: {exc}")
            return result

    def _transcribe_audio_openai(self, audio: bytes, *, mime_type: str | None = None) -> str:
        response = self._request_openai_multipart_json(
            "POST",
            "https://api.openai.com/v1/audio/transcriptions",
            fields=[
                ("model", self.openai_stt_model_id),
            ],
            file_field=(
                "file",
                self._filename_for_mime_type(mime_type),
                mime_type or "audio/webm",
                audio,
            ),
            api_key=self.openai_stt_api_key or "",
        )
        transcript = response.get("text")
        if not isinstance(transcript, str):
            raise RuntimeError("OpenAI speech-to-text returned no transcript.")
        return transcript.strip()

    def _synthesize_openai(self, spoken: str) -> SpeechSynthesisResult:
        started_at = time.perf_counter()
        payload: dict[str, Any] = {
            "model": self.openai_model_id,
            "voice": self.openai_voice,
            "input": spoken,
            "response_format": self.openai_output_format,
        }
        if self.openai_instructions:
            payload["instructions"] = self.openai_instructions
        audio = self._request_openai_binary(
            "POST",
            "https://api.openai.com/v1/audio/speech",
            payload,
            accept=self._mime_type_for_openai_output_format(self.openai_output_format),
            api_key=self.openai_api_key or "",
        )
        synthesis_ms = int((time.perf_counter() - started_at) * 1000)
        audio_base64 = base64.b64encode(audio).decode("ascii") if audio else None
        return SpeechSynthesisResult(
            text=spoken,
            audio_base64=audio_base64,
            audio_mime_type=self._mime_type_for_openai_output_format(self.openai_output_format),
            provider="openai",
            voice_id=self.openai_voice,
            voice_name=self.openai_voice,
            model_id=self.openai_model_id,
            transport="audio-speech",
            latency_mode="streaming-response",
            synthesis_ms=synthesis_ms,
            audio_byte_count=len(audio) if audio else None,
        )

    def _synthesize_streaming(
        self,
        spoken: str,
        voice_id: str,
        voice_name: str | None,
    ) -> SpeechSynthesisResult:
        started_at = time.perf_counter()
        query = urllib.parse.urlencode({"output_format": self.output_format})
        endpoint = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream?{query}"
        audio = self._request_binary(
            "POST",
            endpoint,
            {
                "text": spoken,
                "model_id": self.model_id,
            },
            accept=self._mime_type_for_output_format(self.output_format),
        )
        synthesis_ms = int((time.perf_counter() - started_at) * 1000)
        audio_base64 = base64.b64encode(audio).decode("ascii") if audio else None
        return SpeechSynthesisResult(
            text=spoken,
            duration_ms=None,
            audio_base64=audio_base64,
            audio_mime_type=self._mime_type_for_output_format(self.output_format),
            provider="elevenlabs",
            voice_id=voice_id,
            voice_name=voice_name,
            model_id=self.model_id,
            transport="http-stream",
            latency_mode="low-latency",
            synthesis_ms=synthesis_ms,
            audio_byte_count=len(audio) if audio else None,
        )

    def _synthesize_with_timestamps(
        self,
        spoken: str,
        voice_id: str,
        voice_name: str | None,
    ) -> SpeechSynthesisResult:
        started_at = time.perf_counter()
        query = urllib.parse.urlencode({"output_format": self.output_format})
        endpoint = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps?{query}"
        response = self._request_json(
            "POST",
            endpoint,
            {
                "text": spoken,
                "model_id": self.model_id,
            },
        )
        synthesis_ms = int((time.perf_counter() - started_at) * 1000)
        alignment = self._coerce_alignment(response.get("alignment"))
        normalized_alignment = self._coerce_alignment(response.get("normalized_alignment"))
        duration_ms = self._duration_from_alignment(normalized_alignment or alignment)
        audio_base64 = response.get("audio_base64")
        if not isinstance(audio_base64, str) or not audio_base64.strip():
            audio_base64 = None
        audio_byte_count = None
        if audio_base64:
            try:
                audio_byte_count = len(base64.b64decode(audio_base64, validate=True))
            except ValueError:
                audio_byte_count = None

        return SpeechSynthesisResult(
            text=spoken,
            duration_ms=duration_ms,
            audio_base64=audio_base64,
            audio_mime_type=self._mime_type_for_output_format(self.output_format),
            alignment=alignment,
            normalized_alignment=normalized_alignment,
            provider="elevenlabs",
            voice_id=voice_id,
            voice_name=voice_name,
            model_id=self.model_id,
            transport="with-timestamps",
            latency_mode="alignment",
            synthesis_ms=synthesis_ms,
            audio_byte_count=audio_byte_count,
        )

    def _resolve_voice(self) -> tuple[str | None, str | None]:
        if self._resolved_voice is not None:
            return self._resolved_voice
        if self.voice_id:
            self._resolved_voice = (self.voice_id, self.voice_name)
            return self._resolved_voice

        try:
            response = self._request_json("GET", "https://api.elevenlabs.io/v1/voices")
        except Exception as exc:  # pragma: no cover - depends on live network/service
            self._warn_once(f"ElevenLabs voices lookup failed: {exc}")
            self._resolved_voice = (None, None)
            return self._resolved_voice

        voices = response.get("voices")
        if not isinstance(voices, list) or not voices:
            self._resolved_voice = (None, None)
            return self._resolved_voice

        preferred_name = self.voice_name.lower() if self.voice_name else None
        selected: dict[str, Any] | None = None
        if preferred_name:
            for candidate in voices:
                if (
                    isinstance(candidate, dict)
                    and isinstance(candidate.get("name"), str)
                    and candidate["name"].lower() == preferred_name
                ):
                    selected = candidate
                    break
        if selected is None:
            selected = next((voice for voice in voices if isinstance(voice, dict)), None)

        if not isinstance(selected, dict):
            self._resolved_voice = (None, None)
            return self._resolved_voice

        selected_id = selected.get("voice_id")
        selected_name = selected.get("name")
        self._resolved_voice = (
            selected_id if isinstance(selected_id, str) else None,
            selected_name if isinstance(selected_name, str) else None,
        )
        return self._resolved_voice

    def _request_json(
        self,
        method: str,
        url: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(
            url,
            data=body,
            method=method,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "xi-api-key": self.api_key or "",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(str(exc.reason)) from exc

    def _request_binary(
        self,
        method: str,
        url: str,
        payload: dict[str, Any] | None = None,
        *,
        accept: str,
    ) -> bytes:
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(
            url,
            data=body,
            method=method,
            headers={
                "Accept": accept,
                "Content-Type": "application/json",
                "xi-api-key": self.api_key or "",
            },
        )
        try:
            chunks: list[bytes] = []
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                while True:
                    chunk = response.read(64 * 1024)
                    if not chunk:
                        break
                    chunks.append(chunk)
            return b"".join(chunks)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(str(exc.reason)) from exc

    def _request_openai_binary(
        self,
        method: str,
        url: str,
        payload: dict[str, Any] | None = None,
        *,
        accept: str,
        api_key: str,
    ) -> bytes:
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(
            url,
            data=body,
            method=method,
            headers={
                "Accept": accept,
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
        )
        try:
            chunks: list[bytes] = []
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                while True:
                    chunk = response.read(64 * 1024)
                    if not chunk:
                        break
                    chunks.append(chunk)
            return b"".join(chunks)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(str(exc.reason)) from exc

    def _request_multipart_json(
        self,
        method: str,
        url: str,
        *,
        fields: list[tuple[str, str]],
        file_field: tuple[str, str, str, bytes],
        api_key: str,
    ) -> dict[str, Any]:
        boundary = f"xr-agent-{uuid.uuid4().hex}"
        body = self._encode_multipart_form(boundary, fields, file_field)
        request = urllib.request.Request(
            url,
            data=body,
            method=method,
            headers={
                "Accept": "application/json",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "xi-api-key": api_key,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(str(exc.reason)) from exc

    def _request_openai_multipart_json(
        self,
        method: str,
        url: str,
        *,
        fields: list[tuple[str, str]],
        file_field: tuple[str, str, str, bytes],
        api_key: str,
    ) -> dict[str, Any]:
        boundary = f"xr-agent-{uuid.uuid4().hex}"
        body = self._encode_multipart_form(boundary, fields, file_field)
        request = urllib.request.Request(
            url,
            data=body,
            method=method,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {api_key}",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(str(exc.reason)) from exc

    def _encode_multipart_form(
        self,
        boundary: str,
        fields: list[tuple[str, str]],
        file_field: tuple[str, str, str, bytes],
    ) -> bytes:
        chunks: list[bytes] = []
        for name, value in fields:
            chunks.extend(
                [
                    f"--{boundary}\r\n".encode("utf-8"),
                    f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"),
                    str(value).encode("utf-8"),
                    b"\r\n",
                ]
            )

        file_name, filename, content_type, content = file_field
        chunks.extend(
            [
                f"--{boundary}\r\n".encode("utf-8"),
                (
                    f'Content-Disposition: form-data; name="{file_name}"; '
                    f'filename="{filename}"\r\n'
                ).encode("utf-8"),
                f"Content-Type: {content_type}\r\n\r\n".encode("utf-8"),
                content,
                b"\r\n",
                f"--{boundary}--\r\n".encode("utf-8"),
            ]
        )
        return b"".join(chunks)

    def _filename_for_mime_type(self, mime_type: str | None) -> str:
        normalized = (mime_type or "").split(";", 1)[0].strip().lower()
        extensions = {
            "audio/aac": ".aac",
            "audio/mp4": ".m4a",
            "audio/mpeg": ".mp3",
            "audio/mp3": ".mp3",
            "audio/ogg": ".ogg",
            "audio/opus": ".opus",
            "audio/wav": ".wav",
            "audio/webm": ".webm",
            "audio/x-m4a": ".m4a",
            "audio/x-wav": ".wav",
            "video/webm": ".webm",
        }
        return f"quest-mic{extensions.get(normalized, '.webm')}"

    def _coerce_alignment(self, payload: Any) -> dict[str, list[Any]] | None:
        if not isinstance(payload, dict):
            return None
        normalized: dict[str, list[Any]] = {}
        for key, value in payload.items():
            if isinstance(key, str) and isinstance(value, list):
                normalized[key] = value
        return normalized or None

    def _duration_from_alignment(self, alignment: dict[str, list[Any]] | None) -> int | None:
        if not alignment:
            return None
        end_times = alignment.get("character_end_times_seconds")
        if not isinstance(end_times, list) or not end_times:
            return None
        numeric_times = [value for value in end_times if isinstance(value, (int, float))]
        if not numeric_times:
            return None
        return max(800, int(max(numeric_times) * 1000))

    def _mime_type_for_output_format(self, output_format: str) -> str:
        normalized = output_format.lower()
        if normalized.startswith("wav_"):
            return "audio/wav"
        if normalized.startswith("pcm_"):
            return "audio/wav"
        if normalized.startswith("ulaw_"):
            return "audio/basic"
        return "audio/mpeg"

    def _mime_type_for_openai_output_format(self, output_format: str) -> str:
        normalized = output_format.lower()
        if normalized == "aac":
            return "audio/aac"
        if normalized == "flac":
            return "audio/flac"
        if normalized == "opus":
            return "audio/opus"
        if normalized == "pcm":
            return "audio/wav"
        if normalized == "wav":
            return "audio/wav"
        return "audio/mpeg"

    def _warn_once(self, message: str) -> None:
        if message in self._warned_messages:
            return
        self._warned_messages.add(message)
        print(message, file=sys.stderr)
