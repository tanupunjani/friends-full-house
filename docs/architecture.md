# Engineering notes

## Product shape

Friends Full House is a browser-based party game with two views: a host control surface and a separate audience display. It was built as a static-first prototype using plain HTML, CSS, and JavaScript. There is no frontend framework or package runtime.

```text
Host view ── game actions ──> engine.js ── state ──> Audience view
    │                            │                       │
    └── browser storage + BroadcastChannel (local mode) ─┘

Optional remote deployment:
Host ── authenticated room API ──> Cloudflare Worker ──> D1
Audience ── read-only polling ───> Worker ─────────────> D1
```

## State and scoring

`engine.js` is a small transition module. It accepts the current state and an action and returns a new state for setup, face-off, play, steal, completed rounds, Fast Money, and the final screen. The host view applies those transitions and persists the resulting state. The audience view renders the same game progression but receives only the currently relevant prompt and revealed answers in remote mode.

Regular-round points accumulate in a pot. A successful board awards the multiplied pot to the controlling team; a failed steal awards it to the original team. Skipping consumes the current question, clears that round's pot and strikes, and keeps team scores unchanged. Question IDs are tracked for the entire game so they do not repeat.

Fast Money draws five prompts that were not used in regular play. The host records two contestants' answers in sequence. In remote mode, the Worker clears answer text from the audience snapshot until both submissions are complete; the host can review and adjust example scores before revealing the total.

## Local synchronization

The Pages demo uses the same-origin browser `BroadcastChannel` plus a `storage` event fallback. This works between host and audience tabs in one browser profile. Browser storage is local to that profile and is not shared with a phone or television on a separate device.

## Optional remote synchronization

`worker/index.js` provides room creation, authenticated host reads and writes, read-only audience polling, and static asset serving. A cryptographically random host key is created in the browser; the database stores its SHA-256 hash. Room state and the question bank are written to D1. The audience snapshot includes only the current board and hides unrevealed answer text. The Worker removes rooms after 72 hours of inactivity. It does not provide user accounts, production monitoring, backups, or an SLA.

The Worker is included as source and tested with an in-memory D1-compatible test double. It is not connected to a deployed Worker or live database in this public package. The GitHub Pages demo therefore does not provide cross-device rooms.

## Verification and limitations

Automated Node tests exercise the state transitions and Worker request handling. The package does not include browser automation or a live Cloudflare integration test. No formal accessibility conformance audit, load test, threat model, production incident process, or clinical validation has been completed. Team names and prompts should remain fictional in public demonstrations.
