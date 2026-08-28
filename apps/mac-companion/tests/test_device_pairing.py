import asyncio
import json

import pytest
import websockets

from xr_agent.device_pairing import DevicePairingAuth
from xr_agent.event_server import EventServer, make_event


def test_pairing_is_one_time_expires_and_persists_only_token_hash(tmp_path) -> None:
    now = [1000.0]
    path = tmp_path / "device-auth.json"
    auth = DevicePairingAuth(path, pairing_ttl_seconds=30, clock=lambda: now[0], hash_rounds=10)

    expired, _ = auth.create_pairing()
    now[0] += 31
    assert auth.authenticate_path(f"/?pair={expired}") is None

    code, _ = auth.create_pairing()
    grant = auth.authenticate_path(f"/?pair={code}")
    assert grant is not None and grant.device_token
    assert auth.authenticate_path(f"/?pair={code}") is None
    assert auth.authenticate_path(f"/?token={grant.device_token}") is not None

    persisted = path.read_text(encoding="utf-8")
    assert grant.device_token not in persisted
    assert "digest" in persisted and "salt" in persisted
    assert path.stat().st_mode & 0o777 == 0o600

    reloaded = DevicePairingAuth(path, clock=lambda: now[0], hash_rounds=10)
    assert reloaded.verify_device_token(grant.device_token)
    assert not reloaded.verify_device_token("wrong-token")


def test_event_server_rejects_unauthorized_and_replies_to_one_client(tmp_path) -> None:
    auth = DevicePairingAuth(tmp_path / "auth.json", hash_rounds=10)
    code, _ = auth.create_pairing()
    grant = auth.authenticate_path(f"/?pair={code}")
    assert grant is not None and grant.device_token

    server = EventServer(auth=auth)

    def handler(message, reply):
        reply(make_event("voice.realtime.sdp.answer", None, {"request_id": message["request_id"], "sdp": "private"}))

    server.set_message_handler(handler)
    server.start_in_background("127.0.0.1", 0)
    port = server.bound_port
    assert port is not None

    async def scenario() -> None:
        with pytest.raises(websockets.exceptions.ConnectionClosedError) as rejected:
            async with websockets.connect(f"ws://127.0.0.1:{port}") as unauthorized:
                await unauthorized.recv()
        assert rejected.value.code == 4401

        url = f"ws://127.0.0.1:{port}/?token={grant.device_token}"
        async with websockets.connect(url) as first, websockets.connect(url) as second:
            await first.send(json.dumps({"request_id": "one"}))
            direct = json.loads(await asyncio.wait_for(first.recv(), timeout=2))
            assert direct["type"] == "voice.realtime.sdp.answer"
            assert direct["payload"] == {"request_id": "one", "sdp": "private"}
            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(second.recv(), timeout=0.2)

    try:
        asyncio.run(scenario())
    finally:
        server.stop_in_background()
