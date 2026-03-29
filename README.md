# XR Coding Agent

Mixed reality coding companion built around Hermes.

## Goal

V1 watches assistant-managed terminal sessions on the Mac, tells you when they
finish, and lets you continue the workflow by voice from a headset client.

Hermes is the core agent brain:
- Hermes decides what to run
- Hermes receives follow-up voice instructions
- Hermes summarizes and continues work in the right repo/session context

## Repo Layout

```text
apps/
  mac-companion/      Mac-side runner, Hermes adapter, event bus
  metaquest-client/   Quest Browser MVP client on the same backend/control plane
  visionos-client/    Vision Pro spatial client
docs/                 MVP notes and implementation plan
shared/
  event-schema/       JSON event contract between Mac and headset
  prompts/            Prompt templates for Hermes follow-up actions
```

## V1 Scope

- Track assistant-managed terminal sessions only
- Announce success/failure/needs-attention
- Support voice follow-ups like:
  - "what happened?"
  - "rerun it"
  - "fix that and rerun"
- Keep the headset app simple: avatar + transcript + push-to-talk

## Planning Docs

- `docs/MVP.md`
- `docs/EXECUTION_PLAN.md`
- `docs/ANIMATION_PIPELINE.md`

## Next Build Step

Stabilize the Mac companion and replace the current visionOS checkpoint UI with
the actual assistant surface described in `docs/EXECUTION_PLAN.md`.
