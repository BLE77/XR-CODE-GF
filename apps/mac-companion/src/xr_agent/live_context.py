from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any


REDACTED_CONTEXT_KEYS = (
    "api_key",
    "apikey",
    "authorization",
    "audio_base64",
    "client_secret",
    "password",
    "secret",
    "sdp",
    "token",
)


@dataclass
class LiveContextRecord:
    source: str
    context: dict[str, Any]
    updated_at: float


class LiveContextStore:
    def __init__(self, *, ttl_seconds: float = 45.0, max_sources: int = 8) -> None:
        self.ttl_seconds = ttl_seconds
        self.max_sources = max_sources
        self._records: dict[str, LiveContextRecord] = {}

    def update(self, source: str, context: dict[str, Any], *, now: float | None = None) -> LiveContextRecord:
        timestamp = time.time() if now is None else now
        normalized_source = _clean_source(source)
        record = LiveContextRecord(
            source=normalized_source,
            context=_sanitize_context(context),
            updated_at=timestamp,
        )
        self._records[normalized_source] = record
        self._prune(now=timestamp)
        return record

    def render(self, *, now: float | None = None) -> str:
        timestamp = time.time() if now is None else now
        self._prune(now=timestamp)
        records = sorted(self._records.values(), key=lambda record: record.updated_at, reverse=True)
        if not records:
            return "- none"

        lines = []
        for record in records[: self.max_sources]:
            age = max(0, int(timestamp - record.updated_at))
            compact = json.dumps(record.context, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            if len(compact) > 700:
                compact = compact[:699].rstrip() + "…"
            lines.append(f"- {record.source} age={age}s context={compact}")
        return "\n".join(lines)

    def _prune(self, *, now: float) -> None:
        stale_sources = [
            source
            for source, record in self._records.items()
            if now - record.updated_at > self.ttl_seconds
        ]
        for source in stale_sources:
            self._records.pop(source, None)

        if len(self._records) <= self.max_sources:
            return
        oldest = sorted(self._records.values(), key=lambda record: record.updated_at)
        for record in oldest[: len(self._records) - self.max_sources]:
            self._records.pop(record.source, None)


def _clean_source(source: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "-_." else "-" for ch in source.strip().lower())
    cleaned = "-".join(part for part in cleaned.split("-") if part)
    return cleaned[:48] or "unknown"


def _sanitize_context(value: Any, *, depth: int = 0) -> Any:
    if depth > 4:
        return "[omitted]"
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value if abs(value) < 1_000_000_000 else str(value)
    if isinstance(value, str):
        return _truncate(value)
    if isinstance(value, list):
        return [_sanitize_context(item, depth=depth + 1) for item in value[:8]]
    if isinstance(value, dict):
        sanitized: dict[str, Any] = {}
        for raw_key, raw_item in list(value.items())[:32]:
            key = str(raw_key)[:64]
            lowered = key.lower()
            if any(marker in lowered for marker in REDACTED_CONTEXT_KEYS):
                sanitized[key] = "[redacted]"
                continue
            sanitized[key] = _sanitize_context(raw_item, depth=depth + 1)
        return sanitized
    return _truncate(str(value))


def _truncate(text: str, limit: int = 220) -> str:
    compact = " ".join(text.split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 1].rstrip() + "…"
