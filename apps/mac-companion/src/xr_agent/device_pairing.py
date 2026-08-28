from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.parse import parse_qs, urlsplit


@dataclass(frozen=True)
class PairingGrant:
    device_token: str | None = None


class DevicePairingAuth:
    """One-time pairing codes backed by persisted, salted device-token hashes."""

    def __init__(
        self,
        path: Path,
        *,
        pairing_ttl_seconds: int = 300,
        clock: Callable[[], float] = time.time,
        hash_rounds: int = 200_000,
    ) -> None:
        self.path = path
        self.pairing_ttl_seconds = pairing_ttl_seconds
        self.clock = clock
        self.hash_rounds = hash_rounds
        self._pairings: dict[str, float] = {}
        self._devices = self._load_devices()

    def create_pairing(self) -> tuple[str, float]:
        self._drop_expired_pairings()
        code = secrets.token_urlsafe(12)
        expires_at = self.clock() + self.pairing_ttl_seconds
        self._pairings[code] = expires_at
        return code, expires_at

    def authenticate_path(self, path: str) -> PairingGrant | None:
        query = parse_qs(urlsplit(path).query, keep_blank_values=False)
        token = (query.get("token") or [""])[0]
        if token and self.verify_device_token(token):
            return PairingGrant()

        pairing_code = (query.get("pair") or [""])[0]
        if not pairing_code or not self.consume_pairing(pairing_code):
            return None
        device_token = secrets.token_urlsafe(32)
        self._store_device_token(device_token)
        return PairingGrant(device_token=device_token)

    def consume_pairing(self, code: str) -> bool:
        expires_at = self._pairings.pop(code, None)
        return expires_at is not None and expires_at >= self.clock()

    def verify_device_token(self, token: str) -> bool:
        if not token:
            return False
        for record in self._devices:
            try:
                salt_hex = record["salt"]
                digest_hex = record["digest"]
                if not isinstance(salt_hex, str) or not isinstance(digest_hex, str):
                    continue
                salt = bytes.fromhex(salt_hex)
                expected = bytes.fromhex(digest_hex)
            except (KeyError, TypeError, ValueError):
                continue
            actual = hashlib.pbkdf2_hmac("sha256", token.encode("utf-8"), salt, self.hash_rounds)
            if hmac.compare_digest(actual, expected):
                return True
        return False

    def _store_device_token(self, token: str) -> None:
        salt = secrets.token_bytes(16)
        digest = hashlib.pbkdf2_hmac("sha256", token.encode("utf-8"), salt, self.hash_rounds)
        self._devices.append(
            {"salt": salt.hex(), "digest": digest.hex(), "created_at": int(self.clock())}
        )
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        temporary.write_text(json.dumps({"devices": self._devices}, indent=2), encoding="utf-8")
        os.chmod(temporary, 0o600)
        temporary.replace(self.path)
        os.chmod(self.path, 0o600)

    def _load_devices(self) -> list[dict[str, object]]:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, ValueError):
            return []
        devices = payload.get("devices", []) if isinstance(payload, dict) else []
        return [record for record in devices if isinstance(record, dict)]

    def _drop_expired_pairings(self) -> None:
        now = self.clock()
        self._pairings = {code: expires_at for code, expires_at in self._pairings.items() if expires_at >= now}
