---
"imagos": minor
---

Add `issueRepository` config (asked by `imagos init`, or via the `--issue-repo` flag) to source issues from a separate tracker repository while worktrees, pull requests and merges stay in the code repository. Agent prompts pass `-R <issue repo>` to `gh issue` commands and use `Closes owner/repo#N`, and an issue left open after its PR was merged is now closed explicitly.
