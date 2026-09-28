---
"imagos": major
---

fix: read issue relationships only from GitHub's native fields

The body parser inferred blockers, parents and subtasks from markdown. It had no
notion of direction, so any line pairing a phrase like "depends on" with an issue
reference became a blocker — including prose that said the *other* issue depended
on this one. A spec inheriting that phantom blocker propagated it to every child
through the parent chain, and the whole tree read as blocked.

`blockedBy`, `parent` and `subIssues` now come from GitHub's native issue
relationships alone. Repositories that declared relationships in issue bodies must
convert them to native dependencies and sub-issues.
