# imagos

[![npm version](https://img.shields.io/npm/v/imagos.svg)](https://www.npmjs.com/package/imagos)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Autonomous multi-task GitHub issue orchestrator powered by Claude CLI, Antigravity CLI (agy), git worktrees, and DAG dependency scheduling.

Imagos runs as a local background daemon (a background process that stays running). It watches your GitHub issue backlog for tasks tagged with `ready-for-agent`, builds a dependency graph (a map of which tasks depend on other tasks), and creates isolated git worktrees (separate working folders linked to your repository) to work on multiple issues in parallel. It writes code, runs tests, opens pull requests (proposals to merge code into main), and merges them automatically when ready.

The workflow is based on the agentic pattern introduced by Matt Pocock on [mattpocock/skills](https://github.com/mattpocock/skills), where issues are refined and clarified before being handed off to AI agents.

---

## Quick Start

You can run imagos directly with `npx`:

```bash
# 1. Initialize configuration for your repository
npx imagos init

# 2. Start the orchestrator daemon
npx imagos start
```

Or install it globally:

```bash
pnpm add -g imagos
# or: npm install -g imagos
# or: bun add -g imagos
```

---

## Prerequisites

Before running imagos, make sure you have the GitHub CLI installed and at least one supported AI runner CLI authenticated:

- **GitHub CLI (`gh`)**: Run `gh auth login` so imagos can read issues, post comments, and create pull requests.
- **Claude Code CLI (`claude`)** (if using Claude): Run `claude` and complete authentication.
- **Antigravity CLI (`agy`)** (if using Antigravity): Run `agy` and complete authentication.

---

## Supported AI Runners (Claude & Antigravity)

Imagos supports multiple AI coding tools (runners):

- **Claude Code CLI (`claude`)**: Uses Anthropic's Claude Code tool to implement changes and resolve issues.
- **Antigravity CLI (`agy`)**: Uses Google Antigravity to run agentic coding tasks with configurable models and reasoning effort.

### Choosing the Default Runner

When you run `imagos init`, it detects which CLIs are installed and lets you pick your default runner. You can also configure it in `.autopilot/config.json`:

```json
{
  "runner": "claude"
}
```

Or override it when starting:

```bash
imagos start --runner agy
```

### Tagging Runners Per Issue (with Fallback)

You can assign a specific runner to any individual GitHub issue by adding a label:

- `runner:claude` or `agent:claude`: Routes the task to Claude Code.
- `runner:agy` or `agent:agy`: Routes the task to Antigravity.

**Automatic Fallback**: If an issue has a runner tag for a runner that is not installed or not registered (for example `runner:custom-tool` when only Claude is configured), imagos automatically falls back to the default runner set in your repository configuration.

### Runner-Specific Settings

You can customize runner options in `.autopilot/config.json`. For example, to set the model and reasoning effort (the amount of thinking time the model uses before acting) for Antigravity:

```json
{
  "runner": "agy",
  "runnerConfig": {
    "agy": {
      "model": "gemini-2.5-pro",
      "effort": "high"
    }
  }
}
```

---

## How It Works (The Lifecycle)

1. **Refine your issues**: Write clear acceptance criteria (conditions that must be met for a task to be considered done) and declare any blockers or parent specs using GitHub's own issue relationships — the **Relationships** panel on the issue, or the `gh` CLI.
2. **Tag `ready-for-agent`**: Add the `ready-for-agent` label to issues that are ready to be worked on.
3. **Automated dispatch**: Imagos checks the backlog, resolves dependencies using a DAG (directed acyclic graph, a structure that ensures tasks only run after their prerequisites finish), and assigns ready tasks to workers up to your concurrency limit (the maximum number of tasks running at the same time).
4. **Isolated execution**: Each task runs in its own git worktree (`.autopilot/worktrees/issue-<number>`), keeping your main working directory clean and preventing tasks from conflicting with each other.
5. **Human feedback loop**: If the agent gets stuck or needs clarification, it posts a question in an issue comment, adds the `needs-info` label, and pauses the task. When you reply and re-add `ready-for-agent`, imagos resumes the task right where it left off with your response included.
6. **Testing and pull requests**: The agent writes code, runs your test suite, and opens a PR (pull request).
7. **Auto-merge or human review**:
   - If `autoMerge` is enabled in your config and tests pass, imagos rebases (updates the branch on top of latest main), merges the PR, closes the issue, and cleans up the worktree.
   - If auto-merge is disabled or the agent requests human review, imagos marks the issue as `ready-for-human` so it does not loop, leaving the branch and worktree ready for your review.

---

## Issue Dependencies and Labels

Imagos uses standard GitHub issues and labels to manage tasks without requiring external databases.

### Declaring Relationships

Imagos reads relationships from GitHub's native issue fields only — dependencies,
parent, and sub-issues. Nothing written in an issue body is treated as a relationship,
so prose that mentions another issue can never be mistaken for a dependency.

Set them in the issue's **Relationships** panel, or from the CLI:

```bash
# Mark #102 as blocking #101 — pass the blocker's numeric database id, not its number
gh api --method POST repos/<owner>/<repo>/issues/101/dependencies/blocked_by \
  -F issue_id="$(gh api repos/<owner>/<repo>/issues/102 --jq .id)"
```

Sub-issues give a spec its children, and the child its parent.

Imagos will hold off on starting a task until all of its blockers are closed, and a
child inherits every blocker on the specs above it.

### The 5 Canonical Labels

| Label             | What it means                                                                   | What imagos does                                                                                       |
| :---------------- | :------------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------- |
| `ready-for-agent` | Issue is refined, has clear criteria, and is ready for AI implementation.       | Picks up the task once all blockers are closed, creates a worktree, and runs the agent.                |
| `needs-info`      | The agent encountered an ambiguity and asked a question in the issue comments.  | Pauses the task, keeps the worktree intact, sends a desktop notification, and waits for your reply.    |
| `ready-for-human` | Task requires manual human review, decision, or code review before merging.     | Parks the task and keeps the worktree intact until you finish review or re-tag with `ready-for-agent`. |
| `needs-triage`    | Newly created issue that needs initial acceptance criteria or dependency setup. | Ignored by the agent worker pool until marked `ready-for-agent`.                                       |
| `wontfix`         | Issue rejected or deemed unnecessary.                                           | Ignored and treated as completed so it does not block dependent tasks.                                 |

---

## Scoping to Specific Specs

A spec (specification issue) is a parent issue that groups several smaller child tickets. You can tell imagos to focus only on the subtasks of one or more specs:

```bash
# Scope to a single spec issue
imagos start -s 50

# Scope to multiple specs (comma-separated or repeated flags)
imagos start -s 50,51
imagos start --specs 50 51
imagos start -s 50 -s 51
```

You can also scope inspection and queue commands:

```bash
imagos status -s 50,51
imagos backlog -s 50,51 --ready
```

You can also switch or toggle scoped specs live at runtime using the interactive dashboard.

---

## Interactive Terminal Dashboard (TUI)

When you run `imagos start` in a standard terminal, imagos launches an interactive TUI (terminal user interface, a dashboard rendered inside your terminal):

- **Master Dashboard**: Shows active workers, current git branches, task status, scoped specs, and runner quota telemetry (live usage metrics).
- **Inspect View (`Enter`)**: Select any active worker to view live tool calls, model thoughts, modified files, and diff statistics (a summary of lines added and removed). You can also type in the input bar to inject steering prompts (instructions to guide the agent while it works) in real time.
- **Spec Picker (`/specs`)**: View all open specs and use the Space key to select one or multiple specs to target, or switch to all unblocked tasks.
- **Usage & Quotas (`/usage`)**: View live quota consumption for Claude and Antigravity, including rate limit reset countdowns.
- **Activity Logs (`/logs`)**: Dedicated view of all background events, git operations, and orchestrator decisions.
- **Command Palette (`/` or `:`)**: Run slash commands such as `/specs`, `/usage`, `/logs`, `/resume`, `/status`, `/clean`, `/close`, or `/help`.

### Headless Mode for CI and Background Servers

If you want to run imagos in CI (continuous integration, an automated build and test pipeline) or in a headless environment (without an interactive terminal screen), pass `--no-interactive`:

```bash
imagos start --no-interactive
```

---

## Quota Management and Rate Limits

AI coding tools are subject to rolling rate limits (for example, Claude's 5-hour usage window). Imagos manages this automatically:

- **Automatic Quota Detection**: When a runner hits a rate limit, imagos parses the reset timestamp from the runner's output, pauses active workers for that runner, and schedules an automatic wake-up timer.
- **Multi-Runner Isolation**: If one runner (like Claude) is paused due to quota limits, tasks assigned to other runners (like Antigravity) continue executing without interruption.
- **Manual Resume**: If you upgrade your plan or want to clear the pause state immediately, run:
  ```bash
  imagos resume
  ```
  or type `/resume` in the interactive dashboard.

---

---

## AI Agent Skills (Claude Code, Antigravity, Cursor, Windsurf)

Imagos provides open AI agent skills compatible with the [Open Agent Skills standard](https://skills.sh) via [`vercel-labs/skills`](https://github.com/vercel-labs/skills).

### Available Skills

- **`imagos-summary`** (`skills/imagos-summary/SKILL.md`): Summarizes real-time Work-in-Progress (WIP), active worktrees, live vs paused sessions, quota reset times, and PR review blockers.
- **`imagos-spec-writer`** (`skills/imagos-spec-writer/SKILL.md`): Formats, decomposes, and creates GitHub issues with native GitHub relationships (sub-issues, blockers, parent specs) and `needs-triage` / `ready-for-agent` labels. Automatically detects `mattpocock/skills` for large features or provides fast ad-hoc ticket creation.

### Installing Skills

Install the skills directly into your agent environment:

```bash
# Using the Imagos CLI:
imagos install-skills

# Or using npx skills directly:
npx skills add arleypadua/imagos

# Or install for a specific agent (e.g. claude, antigravity, cursor):
npx skills add arleypadua/imagos -a claude
```

You can also run `/install-skills` inside the interactive TUI command palette.

---

## CLI Commands Reference

| Command                  | Description                                                                                     |
| :----------------------- | :---------------------------------------------------------------------------------------------- |
| `imagos start`           | Start the autonomous daemon and interactive terminal dashboard.                                 |
| `imagos status`          | Show current issue dependency graph, active sessions, and worktree allocations.                 |
| `imagos backlog`         | Inspect and filter the issue queue (`--ready`, `--pending`, `--blocked`, `--triage`, `--json`). |
| `imagos inspect <issue>` | View live agent activity, tool calls, modified files, and git diff summary for an issue.        |
| `imagos logs <issue>`    | View stdout and stderr output logs for a specific issue session.                                |
| `imagos resume`          | Instantly clear quota pause and force immediate task execution.                                 |
| `imagos clean`           | Remove inactive git worktrees, temporary branches, and finished session data.                   |
| `imagos install-skills`  | Install Imagos AI agent skills via `skills.sh` (`npx skills add arleypadua/imagos`).            |
| `imagos init`            | Create or update `.autopilot/config.json` with repository settings and runner selection.        |

---

## Configuration (`.autopilot/config.json`)

Running `imagos init` creates `.autopilot/config.json`. You can customize it to fit your repository:

```json
{
  "$schema": "https://raw.githubusercontent.com/arleypadua/imagos/main/schema.json",
  "repository": "owner/repo",
  "targetSpecs": [50, 51],
  "baseBranch": "main",
  "maxConcurrency": 2,
  "pollIntervalSeconds": 30,
  "extraPrompt": "Always follow our TypeScript coding guidelines in CONTRIBUTING.md.",
  "runner": "claude",
  "runnerConfig": {
    "agy": {
      "model": "gemini-2.5-pro",
      "effort": "high"
    }
  },
  "autoMerge": true,
  "mergeMethod": "squash",
  "cleanupWorktreeOnClose": true,
  "quota": {
    "pauseOnLimit": true,
    "utilizationThresholdLimit": 0.85
  },
  "labels": {
    "readyForAgent": "ready-for-agent",
    "needsInfo": "needs-info",
    "readyForHuman": "ready-for-human",
    "needsTriage": "needs-triage",
    "wontfix": "wontfix"
  }
}
```

### Configuration Options Explained

- `repository`: The GitHub repository in `owner/repo` format. If omitted, imagos detects it from your git origin remote.
- `issueRepository`: An optional separate repository to source issues from, in `owner/repo` format (defaults to `repository`). Use it when your issues live in a dedicated tracker repository: imagos reads, labels, comments on and closes issues there, while worktrees, pull requests and merges stay in `repository`. PRs reference issues as `Closes owner/tracker#12`, so the reference is visible in the code repository even when the tracker is private. `imagos init` asks for it (press Enter to keep issues in the code repository), or pass `--issue-repo <owner/repo>` to `init` or `start`.
- `targetSpecs`: An optional array of parent spec issue numbers to restrict execution to.
- `baseBranch`: The default target branch for pull requests (defaults to `main`).
- `maxConcurrency`: Maximum number of parallel tasks to run at the same time (defaults to `2`).
- `pollIntervalSeconds`: How often in seconds imagos queries GitHub for issue updates (defaults to `30`).
- `extraPrompt`: Custom instructions appended to the prompt given to the AI agent on every task.
- `runner`: Default AI runner to use (`claude` or `agy`).
- `runnerConfig`: Provider-specific settings (such as `model` and `effort` for `agy`).
- `autoMerge`: Whether to automatically squash and merge pull requests when tests pass (defaults to `true`).
- `mergeMethod`: Method used when merging pull requests (`squash`, `merge`, or `rebase`).
- `cleanupWorktreeOnClose`: Whether to delete the worktree folder once an issue is closed and merged (defaults to `true`).
- `quota.pauseOnLimit`: Whether to automatically pause task execution when the quota threshold is reached (defaults to `true`).
- `quota.utilizationThresholdLimit`: Proactive quota utilization threshold to pause task execution (defaults to `0.85`, e.g. `0.70` for 70%).
- `labels`: Mapping of canonical workflow labels to custom label names if your repository uses different names.

---

## Workflow Guide

For detailed definitions of labels and dependency resolution rules, see [docs/agents/triage-labels.md](docs/agents/triage-labels.md).
