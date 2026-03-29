import json

from xr_agent.command_catalog import resolve_repo_commands


def test_resolve_repo_commands_prefers_python_pytest_and_build(tmp_path) -> None:
    (tmp_path / "pyproject.toml").write_text("[project]\nname='demo'\n", encoding="utf-8")

    commands = resolve_repo_commands(tmp_path)

    assert commands.test_command == "python3 -m pytest -q"
    assert commands.build_command == "python3 -m build"


def test_resolve_repo_commands_uses_package_scripts_for_node_projects(tmp_path) -> None:
    package_json = {
        "name": "demo-node",
        "scripts": {
            "test": "vitest run",
            "build": "vite build"
        }
    }
    (tmp_path / "package.json").write_text(json.dumps(package_json), encoding="utf-8")

    commands = resolve_repo_commands(tmp_path)

    assert commands.test_command == "npm test -- --runInBand"
    assert commands.build_command == "npm run build"


def test_resolve_repo_commands_falls_back_to_safe_defaults(tmp_path) -> None:
    commands = resolve_repo_commands(tmp_path)

    assert commands.test_command == "echo 'No test command configured'"
    assert commands.build_command == "echo 'No build command configured'"
