---
"imagos": minor
---

perf(github): sync issues incrementally to stay inside the GitHub GraphQL rate limit

- **Incremental polling**: `fetchIssues` caches issues per repository. After the first full read, each poll only asks for issues updated since the previous one (a 1-point GraphQL page) and merges them in, instead of re-reading the whole repository every tick (~50 points per poll on a ~1000-issue repo, which exhausted the 5,000 points/hour budget at the default 30s interval).
- **Periodic full sync**: every 15 minutes (`fullSyncIntervalMs`) the whole repository is re-read, catching edits that don't bump `updatedAt` and dropping deleted/transferred issues.
- **Rate-limit backoff**: on a rate-limit error the client stops calling GraphQL until the limit resets (read from the free `rate_limit` endpoint) and serves cached issues meanwhile. It no longer falls back to `gh issue list`, which also runs on GraphQL, and a rate-limited first tick no longer aborts `imagos start`.
