# XR Coding Agent / XR Code GF

## Product
This repo is the mixed-reality coding companion for Bless. The product goal is:
- Bless wears a headset
- speaks a command or follow-up
- Hermes runs the coding/task workflow on the Mac
- task state and summaries stream back into XR
- the experience is embodied with an avatar/companion layer, not just a status panel

Hermes is the backend brain/operator.

## Scope
Stay focused on this repo only unless explicitly told otherwise.
Do not mix in UCF, Wishlist Agent, or unrelated project context.
When asked to continue work, assume the task is about XR Code GF unless the user says otherwise.

## Repo Layout
- `apps/mac-companion/` — Python Mac-side runner, Hermes adapter, websocket/event bus
- `apps/metaquest-client/` — React/Vite Quest browser client MVP
- `apps/metaquest-native/` — native Quest client scaffold
- `apps/visionos-client/` — Vision Pro client
- `shared/event-schema/` — shared JSON event contract
- `shared/prompts/` — prompt templates for Hermes follow-up actions
- `docs/` — MVP notes, execution plan, animation pipeline, Quest native plan

## Current Product Truth
From `README.md` and `docs/EXECUTION_PLAN.md`:
- Working now: tracked Mac tasks, persisted sessions, websocket events, Hermes follow-up execution, Vision Pro simulator build/connectivity, repo command detection, automated tests
- Still placeholder/WIP: real voice pipeline, robust intent routing, richer Vision Pro assistant UI, avatar state tied to real assistant loop, onboarding/error handling/device QA
- V1 promise: support commands like `run tests`, `build this`, `what happened?`, `rerun it`, `fix that and rerun`
- Priority areas: Mac companion core, Hermes interaction layer, voice pipeline, headset UX, avatar state machine, reliability

## Tech Surfaces
- Mac companion: Python 3.11+ (`apps/mac-companion/pyproject.toml`)
- Meta Quest browser client: React 19 + TypeScript + Vite + Three.js + VRM (`apps/metaquest-client/package.json`)
- Vision Pro client: visionOS spatial client

## Important Working Rules
- Protect existing uncommitted user changes. This repo is currently dirty; inspect before overwriting.
- Prefer small, testable changes.
- When editing, preserve repo/session context behavior — that is core to the product.
- Never dump full source code into the Obsidian vault. Only log context, status, decisions.
- After meaningful XR work, Hermes should update the vault at `~/Documents/Obsidian Vault/projects/xr-code-gf/status.md` and `~/Documents/Obsidian Vault/wiki/log.md`.

## Useful Commands
- Mac companion tests: `cd apps/mac-companion && python3 -m pytest`
- Meta Quest client build: `cd apps/metaquest-client && npm run build`
- Meta Quest client dev: `cd apps/metaquest-client && npm run dev`

## Session Behavior
When continuing work:
1. Check git status first
2. Read the relevant docs/file paths before editing
3. Keep the XR task scoped and explicit
4. Run the smallest relevant verification step
5. Summarize what changed, what still blocks, and what to do next
