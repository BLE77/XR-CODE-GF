# XR Coding Agent Execution Plan

Last updated: 2026-03-16

## Purpose

Ship a mixed reality coding companion that:

- runs Hermes-backed coding tasks on the Mac
- watches assistant-managed terminal sessions
- announces completion, failure, and attention-needed states
- lets the user continue by voice from Vision Pro
- presents a real 3D character in the headset instead of a plain status window

This plan turns the current prototype into a launchable v1.

## Current State

### Working now

- Mac companion can run tracked commands, persist sessions, and publish websocket events.
- Hermes follow-up execution exists through a thin CLI adapter.
- Vision Pro app builds for the visionOS simulator.
- Vision Pro app can connect to the Mac companion websocket feed.
- Repo command detection and automated tests are in place.

### Still placeholder-level

- Voice is stubbed.
- Intent routing is keyword-only.
- Vision Pro UI is still a model preview plus event feed.
- Avatar state is not yet tied to a real assistant interaction loop.
- Real launch flow, onboarding, error handling, and device QA are missing.

## Product Definition

### V1 promise

The user can say:

- "run tests"
- "build this"
- "what happened?"
- "rerun it"
- "fix that and rerun"

And the system will:

- launch a tracked task on the Mac
- stream task state to the headset
- speak a concise summary when the task completes
- preserve enough session context for the next follow-up

### Not in v1

- attaching to arbitrary existing terminal tabs
- full desktop OCR and semantic understanding
- autonomous agent swarms
- multi-user collaboration
- cross-platform Quest support

## Definition Of Done

### Engineering done

- Mac companion exposes a stable local service that can be started and stopped reliably.
- Vision Pro client connects automatically to the Mac companion on the same machine or network.
- Push-to-talk voice roundtrip works end to end.
- Hermes follow-ups execute in the correct repo with correct previous-session context.
- The avatar visibly changes state for listening, thinking, speaking, success, and alert.
- Session history survives app restarts.
- A new user can run the system from a setup guide without tribal knowledge.

### Launch done

- At least 20 end-to-end task loops succeed in internal dogfooding.
- No blocker bugs remain in task execution, websocket transport, or voice roundtrip.
- Real Vision Pro device smoke test passes.
- Basic crash logging and troubleshooting notes exist.
- Demo flow is reliable enough for live use.

## Workstreams

## 1. Mac Companion Core

Goal: make the Mac runtime trustworthy.

Scope:

- harden session lifecycle
- keep repo/session context correct across follow-ups
- improve failure summaries
- expose health and status endpoints
- package startup into one stable command

Key deliverables:

- `session_runner.py` supports real long-running tasks cleanly
- `main.py` orchestration loop is productionized
- session persistence remains stable across restarts
- websocket server has graceful connect/disconnect behavior
- structured logs and health check command

Exit criteria:

- user can run three consecutive task loops without manual resets
- no dropped completion events in normal use

## 2. Hermes Interaction Layer

Goal: make Hermes feel like the real brain, not a subprocess wrapper.

Scope:

- improve prompt construction for follow-ups
- keep repo/task/session context aligned
- add safer command routing for common developer tasks
- support concise response shaping for headset audio

Key deliverables:

- stronger follow-up prompt template
- context object passed to Hermes for every action
- response trimming for spoken output
- clear fallback messages when Hermes fails or times out

Exit criteria:

- "fix that and rerun" uses the right repo and prior output every time in test scenarios
- spoken summaries are short and useful

## 3. Voice Pipeline

Goal: replace the current fake speech layer with a real one.

Scope:

- push-to-talk capture in Vision Pro app
- speech-to-text on device or Mac-side service
- text-to-speech playback with low-friction latency
- interruption handling

Key deliverables:

- real `SpeechService`
- transcript event plumbing
- TTS queue with cancel/restart behavior
- headset playback and basic mute control

Exit criteria:

- user can speak a command, get a transcript, and hear a reply without touching the Mac

## 4. Vision Pro Experience

Goal: turn the headset app from a model preview into the actual assistant client.

Scope:

- replace the "test checkpoint" UI
- add a real assistant shell
- surface current task, latest summary, and connection status
- support push-to-talk and transcript display
- add graceful reconnects to the event stream

Key deliverables:

- assistant dashboard window
- current-task card
- recent-events transcript strip
- connection state UX
- launch-safe simulator and device behavior

Exit criteria:

- the user can operate the assistant from the headset without reading debug event cards

## 5. Avatar And Interaction Design

Goal: make the assistant feel alive, not just functional.

Scope:

- define avatar state machine
- import your final 3D asset pipeline
- wire animation state to agent state
- add spatial placement and spatial audio

Key deliverables:

- avatar states: `idle`, `listening`, `thinking`, `speaking`, `alert`, `success`
- asset import checklist
- fallback visual if the model fails to load
- one polished default placement experience

Exit criteria:

- the avatar clearly communicates system state at a glance

## 6. QA, Tooling, And Release

Goal: make the system repeatable enough for a real launch.

Scope:

- simulator and device smoke tests
- scripted startup for Mac companion
- log collection and bug-report checklist
- launch checklist and rollback plan

Key deliverables:

- startup script for local launch
- device test checklist
- troubleshooting guide
- demo script

Exit criteria:

- someone other than the core builder can run the product end to end

## Team Structure

## Core team

- Product/Creative Lead
  - owns vision, priority calls, avatar direction, and launch quality bar
- Technical Lead
  - owns architecture, sequencing, code review, and launch readiness
- Mac Companion Engineer
  - owns session runner, websocket service, persistence, and Hermes orchestration
- visionOS Engineer
  - owns headset app UX, event client, voice controls, and device testing
- Agent/Voice Engineer
  - owns STT, TTS, speech events, and Hermes prompt/response shaping
- Technical Artist
  - owns avatar export pipeline, state-based animation assets, and performance budget
- QA/Release Engineer
  - owns smoke tests, bug triage, install docs, and launch rehearsal

## Lean team version

If we keep the team small, this can be done with:

- 1 technical lead/full-stack engineer
- 1 visionOS engineer
- 1 agent/voice engineer
- 1 technical artist
- 1 part-time QA/release owner

## Team Cadence

- Daily 15-minute standup
- Twice-weekly integration review
- End-of-week demo on simulator or device
- Single shared bug list with severity and owner

## Milestones

## Milestone 0: Stabilize Current Prototype

Target: 2 to 3 days

Deliverables:

- fix stale docs
- confirm clean local startup steps
- tighten websocket disconnect handling
- improve summary preservation on failures
- verify repo-aware follow-up behavior

Go/no-go:

- the current prototype can be started locally in under 5 minutes

## Milestone 1: Functional V1 Loop

Target: 1 week

Deliverables:

- reliable command execution loop
- stable session persistence
- real "what happened" and "rerun it" behavior
- real Hermes follow-up loop
- cleaner Vision Pro event-driven UI shell

Go/no-go:

- demo loop works from command start to spoken summary

## Milestone 2: Voice + Assistant UX

Target: 1 week

Deliverables:

- push-to-talk
- real STT/TTS
- concise reply formatting
- headset-first assistant controls

Go/no-go:

- user can complete the loop without touching the keyboard except to start the apps

## Milestone 3: Avatar Integration

Target: 1 week

Deliverables:

- real 3D avatar in place of the generic checkpoint experience
- animation state machine wired to agent events
- spatial audio and polished task-state feedback

Go/no-go:

- the assistant reads as a character, not a dev tool debug panel

## Milestone 4: Device Hardening

Target: 1 week

Deliverables:

- real Vision Pro device testing
- reconnect logic
- failure handling
- performance tuning
- install and demo documentation

Go/no-go:

- three successful device demo sessions with no manual patching

## Milestone 5: Internal Launch

Target: 3 to 4 days

Deliverables:

- launch checklist complete
- bug backlog reduced to non-blockers
- demo script
- install guide

Go/no-go:

- internal team is comfortable using it in real coding sessions

## Critical Path

The true critical path is:

1. stable Mac task execution
2. correct Hermes follow-up context
3. real voice roundtrip
4. Vision Pro assistant UI
5. avatar polish
6. device testing and onboarding

If schedule slips, never cut items 1 through 4.

## Backlog By Priority

## P0

- real speech pipeline
- correct session-context handoff into Hermes
- production-safe websocket behavior
- assistant-first Vision Pro UI
- startup and launch scripts

## P1

- avatar state machine
- spatial audio polish
- better repo command detection
- improved summarization for failing commands

## P2

- richer task history
- app-level settings
- configurable host/port and discovery
- nicer visualization of active tasks

## Risks

## Technical risks

- speech latency makes the interaction feel clunky
- Hermes follow-up prompts are too verbose or too weak
- websocket reconnect edge cases make the headset feel flaky
- Vision Pro app works in simulator but behaves differently on device
- 3D asset scale and performance issues slow down iteration

## Product risks

- assistant interrupts too often
- summaries are too long for spoken delivery
- the headset UI still feels like a debug tool

## Mitigations

- keep push-to-talk for v1
- keep spoken summaries under two sentences
- dogfood daily with real coding tasks
- treat device testing as an early, recurring activity

## Immediate Next 10 Tasks

1. Update stale visionOS setup docs to reflect the real project and simulator target.
2. Add a `run-local` startup script for the Mac companion.
3. Harden websocket disconnect handling and remove noisy close-path stack traces.
4. Preserve startup error details instead of overwriting them with generic summaries.
5. Fix generic follow-up repo/context mismatches.
6. Replace the current Vision Pro checkpoint UI with an assistant shell.
7. Implement push-to-talk in the Vision Pro client.
8. Implement real STT/TTS in `SpeechService`.
9. Wire avatar state to agent events.
10. Run a real device smoke test and record issues.

## Suggested Ownership

## Week 1

- Technical Lead
  - milestone planning
  - bug triage
  - architecture review
- Mac Companion Engineer
  - tasks 2, 3, 4, 5
- visionOS Engineer
  - task 6
- Agent/Voice Engineer
  - task 8 groundwork
- Technical Artist
  - avatar import requirements and state list

## Week 2

- visionOS Engineer
  - task 7
- Agent/Voice Engineer
  - finish task 8
- Mac Companion Engineer
  - headset integration support
- Technical Artist
  - task 9
- QA/Release
  - task 10 and install checklist

## Launch Checklist

- Mac companion starts from one documented command
- Vision Pro app launches on simulator and real device
- Websocket connection is stable
- User can issue at least five spoken commands successfully
- Hermes follow-up actions stay in the correct repo
- Avatar states are visually clear
- Logs are available for troubleshooting
- Setup guide is accurate

## Success Metric

The launch is successful if the user can wear the headset, say "run tests", hear the result, and continue with "fix that and rerun" without breaking flow.
