---
"imagos": patch
---

fix(quota): stop a quota pause from freezing runners past its own reset window

A pause taken on a reset time that has already passed left every runner of that provider SIGSTOPped with
nothing scheduled to wake them: the resume was a 1s no-op timer, the entry stayed in `pausedRunners`, and
`/status` reported `Paused until <a time in the past>` while the daemon believed it was healthy.

- `triggerQuotaPause()` now refuses a reset that is already in the past instead of stopping the runners for
  a window they are no longer inside.
- The resume timer is scheduled before `quota_paused` is emitted, so a listener that throws can no longer
  leave runners stopped with no wake-up on the clock.
- `fetchLiveUsage()` reconciles on every poll: any process the monitor stopped whose runner is no longer
  paused gets a SIGCONT, so a lost resume self-heals within one tick.
- `getStatus()` prunes expired pauses, so the TUI and the Telegram `/status` stop reporting a pause that
  has already lapsed.
- Reset strings parse a just-passed clock time as the window that rolled rather than the same time
  tomorrow, which is what turned a poll two minutes after a 5h boundary into a day-long pause.
