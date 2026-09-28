import type { GitHubIssue, ParsedDependencies, TaskKind } from '../types/index.js';

export function parseIssueDependencies(issue: GitHubIssue): ParsedDependencies {
  const body = issue.body || '';
  const blockers: Set<number> = new Set();
  const subTaskNumbers: Set<number> = new Set();
  const parentNumber: number | undefined = issue.parent?.number;

  if (issue.blockedBy) {
    for (const b of issue.blockedBy) {
      if (b.number !== issue.number) {
        blockers.add(b.number);
      }
    }
  }

  if (issue.subIssues) {
    for (const s of issue.subIssues) {
      if (s.number !== issue.number) {
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
    parentNumber,
    subTaskNumbers: Array.from(subTaskNumbers),
    kind,
  };
}
