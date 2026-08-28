import asyncio
import importlib.util
import os
import stat
from types import SimpleNamespace
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).resolve().parents[1] / "mobile_realtime_gateway.py"
spec = importlib.util.spec_from_file_location("mobile_realtime_gateway", MODULE_PATH)
assert spec and spec.loader
realtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(realtime)


def test_token_is_strong_stable_and_private(tmp_path):
    path = tmp_path / "token"
    first = realtime.ensure_token(path)
    second = realtime.ensure_token(path)
    assert first == second
    assert len(first) >= 32
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_token_rejects_weak_existing_value(tmp_path):
    path = tmp_path / "token"
    path.write_text("short")
    with pytest.raises(RuntimeError, match="too short"):
        realtime.ensure_token(path)


def test_authenticated_path_requires_exact_token():
    token = "a" * 40
    assert realtime.authenticated_path(f"/realtime?token={token}", token)
    assert not realtime.authenticated_path("/realtime", token)
    assert not realtime.authenticated_path("/realtime?token=wrong", token)


def test_native_authorization_header_avoids_query_token():
    token = "b" * 40
    assert realtime.authenticated_request("/realtime", f"Bearer {token}", token)
    assert not realtime.authenticated_request("/realtime", "Bearer wrong", token)


def test_pcm_track_outputs_twenty_millisecond_frames():
    async def check():
        queue = asyncio.Queue()
        await queue.put(bytes(realtime.FRAME_BYTES // 2))
        await queue.put(bytes(realtime.FRAME_BYTES // 2))
        track = realtime.PCMQueueTrack(queue)
        frame = await track.recv()
        assert frame.samples == realtime.FRAME_SAMPLES
        assert frame.sample_rate == realtime.SAMPLE_RATE
        assert frame.layout.name == "mono"
        track.stop()

    asyncio.run(check())


def test_protocol_constants_are_directionally_distinct():
    assert realtime.INPUT_AUDIO == 0x01
    assert realtime.OUTPUT_AUDIO == 0x02
    assert realtime.INPUT_AUDIO != realtime.OUTPUT_AUDIO
    assert realtime.MAX_AUDIO_MESSAGE >= realtime.FRAME_BYTES


def test_session_exposes_full_hermes_delegation(monkeypatch):
    monkeypatch.setattr(realtime.voice_runtime, "ask_hermes", object())
    peer = realtime.MobileRealtimePeer.__new__(realtime.MobileRealtimePeer)
    peer.client = SimpleNamespace(store=SimpleNamespace(resume_brief=lambda: "Persisted handoff"))

    config = peer.session_config()["session"]
    tools = {tool["name"] for tool in config["tools"]}

    assert "ask_hermy" in tools
    assert "save_session_note" in tools
    assert "request_callback" in tools
    assert "same full Hermes Agent and Mac tools" in config["instructions"]
    assert "Persisted handoff" in config["instructions"]
    assert "macOS Computer Use" in config["instructions"]
    ask_hermy = next(tool for tool in config["tools"] if tool["name"] == "ask_hermy")
    assert "existing Chrome window" in ask_hermy["description"]


def test_server_vad_rejects_ambient_noise_and_waits_for_complete_turn(monkeypatch):
    monkeypatch.setattr(realtime.voice_runtime, "ask_hermes", object())
    peer = realtime.MobileRealtimePeer.__new__(realtime.MobileRealtimePeer)
    peer.client = SimpleNamespace(store=SimpleNamespace(resume_brief=lambda: ""))

    vad = peer.session_config()["session"]["audio"]["input"]["turn_detection"]
    assert vad["type"] == "server_vad"
    assert vad["threshold"] >= 0.8
    assert vad["silence_duration_ms"] >= 1000
    assert vad["create_response"] is True


def test_provider_connect_does_not_force_a_greeting():
    source = MODULE_PATH.read_text(encoding="utf-8")
    assert "Mobile Yuki is live. What should we work on?" not in source


def test_completion_reporting_cannot_recurse_into_tools():
    source = MODULE_PATH.read_text(encoding="utf-8")
    assert '"tool_choice": "none"' in source
    assert "Do not call tools" in source
    assert "AUTHORITATIVE COMPLETION" in source
