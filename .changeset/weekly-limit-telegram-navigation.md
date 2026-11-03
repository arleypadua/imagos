---
"imagos": minor
---

Add a weekly usage limit (`quota.weeklyThresholdLimit`, 90% by default) next to the 5h limit, so workers also pause when the weekly window runs low, including when the 5h limit is lifted. Both limits can be changed on a running daemon with `imagos limits --weekly <pct> --5h <pct>` or Telegram's `/limits`, and are written back to the saved config.

Telegram messages now carry buttons: links to the issue and its pull request, and follow-ups that move between views in place — a `/menu`, issue pickers for inspect, logs and steer, per-issue controls (steer, pause, resume, run now), and limit adjusters. Inspect shows the last 15 live-tail events instead of 5, and logs show 60 lines instead of 30.
