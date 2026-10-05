---
"imagos": patch
---

Resolve blockers that live in another repository by the state GitHub reports for them, instead of looking their number up among this repository's issues. A closed cross-repo blocker no longer leaves its dependent blocked forever, and a local issue that shares the number can no longer decide it. Cross-repo sub-issues and parents are ignored for the same reason.
