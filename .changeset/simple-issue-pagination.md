---
"imagos": minor
---

feat(remote): replace the Telegram issue tree browser with a simple paginated issue list

- **Flat issue list**: `/browse` (and its `/issues`, `/tree`, `/browse-issues` aliases) now renders open issues as `#number title` with a link to the issue on GitHub, 10 per page.
- **Priority order**: the list is ordered by the same criteria that decide dispatch order (`PRIORITY_CRITERIA`), via a new `IssueDAG.getOpenNodesByPriority()` — so what you read at the top of `/browse` is what the scheduler would pick up next.
- **Pagination**: Previous/Next buttons page through the list in place; `/browse <page>` jumps straight to a page and out-of-range pages clamp to the first/last.
- **Removed**: spec drill-down, the open-only filter toggle, per-issue and bulk enqueue buttons, and the `v1:b:r`/`v1:b:s`/`v1:b:t`/`v1:b:ea` callbacks, all replaced by a single `v1:b:p:<page>` callback. The TUI issue browser is unchanged.
