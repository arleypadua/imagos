import type { ExternalBlocker, GitHubIssue, ParsedDependencies, TaskKind } from '../types/index.js';

/**
 * Whether a related issue lives in the same repository as `issue`. Issue numbers are only unique
 * within a repository, so a cross-repo relation must never be resolved by number against this
 * repository's issues. When either side doesn't report its repository, it is assumed local.
 */
export function isSameRepository(issue: GitHubIssue, related: { repository?: string }): boolean {
  if (!issue.repository || !related.repository) return true;
  return issue.repository.toLowerCase() === related.repository.toLowerCase();
}

export function parseIssueDependencies(issue: GitHubIssue): ParsedDependencies {
  const body = issue.body || '';
  const blockers: Set<number> = new Set();
  const externalBlockers: ExternalBlocker[] = [];
  const subTaskNumbers: Set<number> = new Set();
  const parentNumber: number | undefined =
    issue.parent && isSameRepository(issue, issue.parent) ? issue.parent.number : undefined;

  if (issue.blockedBy) {
    for (const b of issue.blockedBy) {
      if (!isSameRepository(issue, b)) {
        externalBlockers.push({ repository: b.repository!, number: b.number, title: b.title, state: b.state });
      } else if (b.number !== issue.number) {
        blockers.add(b.number);
      }
    }
  }

  if (issue.subIssues) {
    for (const s of issue.subIssues) {
      if (isSameRepository(issue, s) && s.number !== issue.number) {
        subTaskNumbers.add(s.number);
      }
    }
  }

  let kind: TaskKind = 'standalone';
  const isSpecTitle = /^(?:\[\s*(?:spec|epic)\s*\]|(?:\(spec\)|\(epic\))|(?:spec|epic)\s*[:\-–—])/i.test(issue.title.trim());
  const isSpecLabel = (issue.labels || []).some((l) =>
    /^(?:spec|specs|specification|specifications|epic|epics)$/i.test(l.name.trim())
  );
  const hasAcceptanceCriteria = /(?:acceptance\s+criteria|specifications?|requirements)/i.test(body);
  const hasSubTasks = subTaskNumbers.size > 0;

  if (isSpecTitle || isSpecLabel || (hasAcceptanceCriteria && hasSubTasks)) {
    kind = 'spec';
  } else if (parentNumber !== undefined) {
    kind = 'ticket';
  }

  return {
    blockers: Array.from(blockers),
    externalBlockers,
    parentNumber,
    subTaskNumbers: Array.from(subTaskNumbers),
    kind,
  };
}
