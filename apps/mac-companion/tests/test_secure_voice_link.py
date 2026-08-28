import json
import os

from xr_agent.config import AppConfig
from xr_agent.main import build_app


class FakeResponse:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return b"v=0\r\nfake-oauth-answer"


def test_oauth_sdp_broker_keeps_credentials_in_mac_headers(tmp_path, monkeypatch) -> None:
    auth_path = tmp_path / "auth.json"
    auth_path.write_text(
        json.dumps(
            {
                "providers": {
                    "openai-codex": {
                        "tokens": {
                            "access_token": "oauth-test-token",
                            "account_id": "acct-test",
                        }
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("XR_AGENT_OPENAI_AUTH_PATH", str(auth_path))
    monkeypatch.setenv("OPENAI_REALTIME_MODEL", "gpt-realtime-test")
    captured = {}

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["data"] = request.data
        captured["headers"] = {key.lower(): value for key, value in request.header_items()}
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))

    answer, session = app._create_realtime_call_answer(sdp="v=0\r\nfake-offer", repo_path=str(tmp_path))

    assert answer == "v=0\r\nfake-oauth-answer"
    assert session["model"] == "gpt-realtime-test"
    assert captured["url"].endswith("/v1/realtime/calls?model=gpt-realtime-test")
    assert captured["data"] == b"v=0\r\nfake-offer"
    assert captured["headers"]["authorization"] == "Bearer oauth-test-token"
    assert captured["headers"]["chatgpt-account-id"] == "acct-test"
    assert captured["headers"]["content-type"] == "application/sdp"
    assert "oauth-test-token" not in json.dumps(session)
    assert "acct-test" not in json.dumps(session)


def test_build_app_authenticates_external_event_server(tmp_path) -> None:
    app = build_app(AppConfig(hermes_cmd="echo", state_dir=tmp_path / "state"))

    assert app.events.auth is not None
    assert app.events.auth.path == tmp_path / "state" / "device-auth.json"
