from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass
class AppConfig:
    hermes_cmd: str = "hermes"
    state_dir: Path = Path.home() / ".xr-coding-agent"
    max_output_tail_lines: int = 50
    event_host: str = "0.0.0.0"
    event_port: int = 8765
    control_host: str = "127.0.0.1"
    control_port: int = 8766
    command_center_enabled: bool = True
    command_center_host: str = "127.0.0.1"
    command_center_port: int = 0
    command_center_open_browser: bool = False
    default_repo_path: Path = Path.cwd()
    project_search_roots: tuple[Path, ...] = ()
