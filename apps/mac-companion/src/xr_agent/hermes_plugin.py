from __future__ import annotations

import os
from pathlib import Path


def managed_session_plugin_source_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "hermes_plugins" / "xr_managed_sessions"


def install_managed_session_plugin(hermes_home: str | Path | None = None) -> Path:
    source_dir = managed_session_plugin_source_dir()
    if not source_dir.exists():
        raise FileNotFoundError(f"Hermes plugin source directory is missing: {source_dir}")

    root = Path(hermes_home or os.environ.get("HERMES_HOME", Path.home() / ".hermes")).expanduser().resolve()
    destination_dir = root / "plugins" / "xr_managed_sessions"
    destination_dir.mkdir(parents=True, exist_ok=True)
    expected_paths = {path.relative_to(source_dir) for path in source_dir.rglob("*")}

    for source_path in source_dir.rglob("*"):
        relative_path = source_path.relative_to(source_dir)
        destination_path = destination_dir / relative_path
        if source_path.is_dir():
            destination_path.mkdir(parents=True, exist_ok=True)
            continue

        destination_path.parent.mkdir(parents=True, exist_ok=True)
        content = source_path.read_text(encoding="utf-8")
        if destination_path.exists() and destination_path.read_text(encoding="utf-8") == content:
            continue
        destination_path.write_text(content, encoding="utf-8")

    stale_paths = sorted(
        (path for path in destination_dir.rglob("*") if path.relative_to(destination_dir) not in expected_paths),
        key=lambda path: len(path.parts),
        reverse=True,
    )
    for stale_path in stale_paths:
        if stale_path.is_dir():
            stale_path.rmdir()
            continue
        stale_path.unlink()

    return destination_dir
