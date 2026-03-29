from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class RepoCommands:
    test_command: str
    build_command: str


def resolve_repo_commands(repo_path: str | Path) -> RepoCommands:
    repo_root = Path(repo_path)

    if (repo_root / "pyproject.toml").exists() or (repo_root / "pytest.ini").exists():
        return RepoCommands(
            test_command="python3 -m pytest -q",
            build_command="python3 -m build",
        )

    package_json_path = repo_root / "package.json"
    if package_json_path.exists():
        try:
            package_json = json.loads(package_json_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            package_json = {}
        scripts = package_json.get("scripts", {}) if isinstance(package_json, dict) else {}
        test_command = (
            "npm test -- --runInBand"
            if scripts.get("test")
            else "echo 'No test command configured'"
        )
        build_command = (
            "npm run build"
            if scripts.get("build")
            else "echo 'No build command configured'"
        )
        return RepoCommands(test_command=test_command, build_command=build_command)

    return RepoCommands(
        test_command="echo 'No test command configured'",
        build_command="echo 'No build command configured'",
    )
