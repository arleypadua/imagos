---
"imagos": minor
---

Agents now run in their own process group, and everything they started is killed when each agent round ends, so dev servers, watchers and background jobs no longer pile up across tasks. Processes that left the group but still run inside a worktree are swept when the worktree is removed and on daemon startup. Quota pauses and manual pause/resume now freeze and continue an agent's tool processes along with the agent.
