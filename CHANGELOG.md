# imagos

## 1.0.1

### Patch Changes

- 3ad1582: Resolve blockers that live in another repository by the state GitHub reports for them, instead of looking their number up among this repository's issues. A closed cross-repo blocker no longer leaves its dependent blocked forever, and a local issue that shares the number can no longer decide it. Cross-repo sub-issues and parents are ignored for the same reason.

## 1.0.0

### Major Changes

- dae9f7e: fix: read issue relationships only from GitHub's native fields

  The body parser inferred blockers, parents and subtasks from markdown. It had no
  notion of direction, so any line pairing a phrase like "depends on" with an issue
  reference became a blocker — including prose that said the _other_ issue depended
  on this one. A spec inheriting that phantom blocker propagated it to every child
  through the parent chain, and the whole tree read as blocked.

  `blockedBy`, `parent` and `subIssues` now come from GitHub's native issue
  relationships alone. Repositories that declared relationships in issue bodies must
  convert them to native dependencies and sub-issues.

### Minor Changes

- e0e4503: The terminal live tail / session history view now shows the whole agent session instead of the last 14 truncated lines. Messages are shown in full with light markdown formatting, tool calls are pretty-printed (Bash commands, Edit/Write diffs, todo lists), and tool results show a preview that Tab expands. Scroll with ↑/↓, PgUp/PgDn and Home/End; scrolling back to the bottom resumes following new activity.
- dae9f7e: perf(github): sync issues incrementally to stay inside the GitHub GraphQL rate limit

  - **Incremental polling**: `fetchIssues` caches issues per repository. After the first full read, each poll only asks for issues updated since the previous one (a 1-point GraphQL page) and merges them in, instead of re-reading the whole repository every tick (~50 points per poll on a ~1000-issue repo, which exhausted the 5,000 points/hour budget at the default 30s interval).
  - **Periodic full sync**: every 15 minutes (`fullSyncIntervalMs`) the whole repository is re-read, catching edits that don't bump `updatedAt` and dropping deleted/transferred issues.
  - **Rate-limit backoff**: on a rate-limit error the client stops calling GraphQL until the limit resets (read from the free `rate_limit` endpoint) and serves cached issues meanwhile. It no longer falls back to `gh issue list`, which also runs on GraphQL, and a rate-limited first tick no longer aborts `imagos start`.

- e78a0bf: Agents now run in their own process group, and everything they started is killed when each agent round ends, so dev servers, watchers and background jobs no longer pile up across tasks. Processes that left the group but still run inside a worktree are swept when the worktree is removed and on daemon startup. Quota pauses and manual pause/resume now freeze and continue an agent's tool processes along with the agent.
- 629d97d: Add `issueRepository` config (asked by `imagos init`, or via the `--issue-repo` flag) to source issues from a separate tracker repository while worktrees, pull requests and merges stay in the code repository. Agent prompts pass `-R <issue repo>` to `gh issue` commands and use `Closes owner/repo#N`, and an issue left open after its PR was merged is now closed explicitly.
- dae9f7e: feat(remote): replace the Telegram issue tree browser with a simple paginated issue list

  - **Flat issue list**: `/browse` (and its `/issues`, `/tree`, `/browse-issues` aliases) now renders open issues as `#number title` with a link to the issue on GitHub, 10 per page.
  - **Priority order**: the list is ordered by the same criteria that decide dispatch order (`PRIORITY_CRITERIA`), via a new `IssueDAG.getOpenNodesByPriority()` — so what you read at the top of `/browse` is what the scheduler would pick up next.
  - **Pagination**: Previous/Next buttons page through the list in place; `/browse <page>` jumps straight to a page and out-of-range pages clamp to the first/last.
  - **Removed**: spec drill-down, the open-only filter toggle, per-issue and bulk enqueue buttons, and the `v1:b:r`/`v1:b:s`/`v1:b:t`/`v1:b:ea` callbacks, all replaced by a single `v1:b:p:<page>` callback. The TUI issue browser is unchanged.

- 9b30b84: feat: add triage backlog section under Issue DAG Queue

  - **Issue DAG Queue Triage Section**: Added a dedicated `📋 Needs Triage:` section in the Master Dashboard TUI and CLI table overview to view untriaged open issues (`needs-triage`).
  - **Interactive Backlog Drill-down**: Enabled selecting and inspecting the triage backlog in the interactive Category Issues View (press Enter on Needs Triage row), displaying the `📋 needs triage` status badge and supporting actions to enqueue, inspect, or open issues in browser.
  - **DAG Triage Queries**: Added `getTriageNodes()` to `IssueDAG` returning open un-triaged tasks and respecting spec scope.

### Patch Changes

- dae9f7e: fix(quota): stop a quota pause from freezing runners past its own reset window

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

## 0.7.0

### Minor Changes

- 5b44251: feat: interactive issue tree browser for TUI and Telegram remote control

  - **TUI Issue Tree Browser**: Added 2-level hierarchy view accessible via `/browse-issues` (aliases: `/browse`, `/issues`, `/tree`) showing open specifications with expand/collapse state (`▶`/`▼`), completion progress `[x/y completed]`, and indented child tickets (`├──`, `└──`) with dimmed checkmarks on closed tasks. Standalone issues are displayed with `●`.
  - **Keyboard Navigation & Controls**: Added `[Space]`/`[→]`/`[←]` to toggle specs, `[←]` on child items to collapse parent and return cursor to parent spec row, `[c]` to toggle open-only filter vs all tasks, `[a]` to toggle expand/collapse all, `[e]` to enqueue with confirmation, `[o]` to open in browser, `[p]` to pause/resume, `[k]` to kill worker and wipe worktree, and `[Enter]`/`[i]` to inspect live tail.
  - **Telegram Remote Interactive Browser**: Registered `/browse` in bot menu (`BOT_COMMANDS`) and implemented interactive drill-down navigation via inline message editing. Supports spec drill-down views, open-only filter toggling, per-task enqueue buttons, bulk enqueueing (`[⚡ Enqueue All Open Tasks]`), and return navigation (`[⬅️ Back to Tree]`).

## 0.6.0

### Minor Changes

- 12a4d6e: feat: manual issue enqueue, issue discussion comments in prompts, Telegram session steering, and contextual command suggestions

  - **Manual issue enqueue**: Added in-memory priority queue scheduling (`/enqueue`, `/run`, `/dispatch`, and `e` key in TUI) allowing any issue to be queued regardless of blocked or spec state, with confirmation prompts, `--force` bypass, on-demand GitHub fetching, and automated label synchronization (`ready-for-agent` added, review labels cleared).
  - **Issue comments in task prompts**: Query GraphQL issue comments (up to 50) and embed discussion threads, notes, and triage briefs directly into runner prompts and guidelines.
  - **Telegram session steering**: Added `/steer [issueNumber] <instructions>` command and notification swipe-to-reply steering, providing immediate injection confirmation followed by an 8-second live tail impact report summarizing agent tool calls, status, and worktree git diffs.
  - **Contextual command suggestions**: Running `/steer`, `/enqueue`, `/inspect`, `/logs`, `/pause`, `/resume`, or `/help` without arguments dynamically embeds live session context (active workers, paused tasks, and enqueued/ready issues) with tap-to-copy monospace command shortcuts.

### Patch Changes

- 37322a9: fix: enforce needs-triage on agent follow-up tasks, deduplicate runner prompts, and add 2-minute quota reset safety margin

  - Enforce `needs-triage` label on all agent-created follow-up subtasks (preventing unapproved task auto-enqueuing) with proposed solutions and reasoning at the bottom of the issue body.
  - Extract shared runner prompt builder (`src/runners/prompt.ts`) and streamline continuation prompts by omitting redundant task descriptions and guidelines.
  - Add 2-minute safety buffer to quota reset calculations to prevent premature boundary wakeups and rolling window re-triggering.
  - Add concise instructions in Telegram `needs-info` notifications for swipe-to-reply or manual GitHub issue comments.

## 0.5.0

### Minor Changes

- 3818766: feat: extensible Telegram remote control integration including interactive setup wizard (`imagos init`), runtime toggle flags (`imagos start --remote` / `--no-remote`), graceful shutdown on process signals (`SIGINT`/`SIGTERM`), slash command controls, interactive needs-info steering, one-tap quota resumption alerts, and outbound milestone notifications.

## 0.4.0

### Minor Changes

- 08b5faa: feat: add AI agent skills (`imagos-summary`, `imagos-spec-writer`) compatible with `vercel-labs/skills` (skills.sh) with human-only invocation, and add `/install-skills` command to CLI and TUI palette.

## 0.3.0

### Minor Changes

- a132f82: feat: add automated agent nudge loop for unmerged turns, dynamic autoMerge prompts, smooth TUI backlog scrolling, and unified specifications & scope management view.

### Patch Changes

- eebe384: fix: propagate parent spec blockers down to all child tickets in the DAG, support native GitHub issue relationships (`blockedBy`, `parent`, `subIssues`) via GraphQL, and automatically prune completed or closed specs from the active target scope with activity logging.

## 0.2.2

### Patch Changes

- d7f0b1f: docs: revamp README with comprehensive guide for Claude and Antigravity (agy) runners, runner label routing and fallback, multi-spec scoping, and quota management.

## 0.2.1

### Patch Changes

- 8f09d6b: fix: automatically detect unmerged PRs upon agent completion, attempt auto-merge if enabled, transition tasks to `ready-for-human` on GitHub to prevent infinite re-dispatch, and accurately display in-review worktrees in the dashboard.

## 0.2.0

### Minor Changes

- bd9d65e: Allow specifying multiple target specs when starting imagos and across CLI commands (`-s, --spec`, `--specs`, and `targetSpecs` in configuration).

## 0.1.1

### Patch Changes

- 1e01308: Initial release setup with automated publishing workflow and package metadata.
