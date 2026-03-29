# MVP

## System Shape

- Mac companion owns task execution, session context, and Hermes integration
- Vision Pro client is the mixed reality face of the system
- Shared JSON events move over a local transport layer

## Session Lifecycle

1. User speaks: "run tests"
2. Command router turns speech into a tracked action
3. Hermes adapter chooses repo-aware work
4. Session runner launches a managed shell session
5. Session store records status and output tail
6. Summarizer produces a short spoken update
7. User replies: "fix that and rerun"
8. Hermes adapter uses the last completed session as follow-up context

## V1 Constraints

- Only assistant-managed sessions
- Push-to-talk voice input
- No OCR or full desktop semantic awareness yet
- No arbitrary terminal attachment yet
