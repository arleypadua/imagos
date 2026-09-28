import { describe, it, expect } from 'vitest';
import type { DAGNode, GitHubIssue, TaskStatus } from '../src/types/index.js';
import {
  createPriorityContext,
  explainPriority,
  lowestIssueNumber,
  readinessAge,
  sortByPriority,
  specContinuity,
  unblockingPower,
} from '../src/github/priority.js';

interface NodeSpec {
  number: number;
  status?: TaskStatus;
  dependents?: number[];
  parentNumber?: number;
  children?: number[];
  createdAt?: string;
}

function node(spec: NodeSpec): DAGNode {
  const issue: GitHubIssue = {
    number: spec.number,
    title: `Issue ${spec.number}`,
    body: '',
    state: 'OPEN',
    labels: [{ name: 'ready-for-agent' }],
    url: `https://github.com/owner/repo/issues/${spec.number}`,
    createdAt: spec.createdAt ?? '2026-08-01T00:00:00Z',
    updatedAt: spec.createdAt ?? '2026-08-01T00:00:00Z',
  };

  return {
    issue,
    kind: 'ticket',
    blockers: [],
    dependents: spec.dependents ?? [],
    parentNumber: spec.parentNumber,
    children: spec.children ?? [],
    status: spec.status ?? 'ready',
  };
}

function context(...nodes: DAGNode[]) {
  return createPriorityContext(new Map(nodes.map((n) => [n.issue.number, n])));
}

describe('priority criteria', () => {
  describe('unblockingPower', () => {
    it('should count every issue transitively downstream of the node', () => {
      const a = node({ number: 1, dependents: [2] });
      const b = node({ number: 2, dependents: [3, 4] });
      const c = node({ number: 3 });
      const d = node({ number: 4 });
      const ctx = context(a, b, c, d);

      expect(unblockingPower.score(a, ctx)).toBe(3);
      expect(unblockingPower.score(b, ctx)).toBe(2);
      expect(unblockingPower.score(c, ctx)).toBe(0);
    });

    it('should not count dependents that are already completed', () => {
      const a = node({ number: 1, dependents: [2, 3] });
      const done = node({ number: 2, status: 'completed' });
      const open = node({ number: 3 });

      expect(unblockingPower.score(a, context(a, done, open))).toBe(1);
    });

    it('should terminate on a dependency cycle', () => {
      const a = node({ number: 1, dependents: [2] });
      const b = node({ number: 2, dependents: [1] });

      expect(unblockingPower.score(a, context(a, b))).toBe(1);
    });
  });

  describe('specContinuity', () => {
    it('should rank a ticket by how far along its parent spec already is', () => {
      const spec = node({ number: 100, children: [101, 102, 103, 104] });
      const done1 = node({ number: 101, parentNumber: 100, status: 'completed' });
      const done2 = node({ number: 102, parentNumber: 100, status: 'completed' });
      const done3 = node({ number: 103, parentNumber: 100, status: 'completed' });
      const todo = node({ number: 104, parentNumber: 100 });

      expect(specContinuity.score(todo, context(spec, done1, done2, done3, todo))).toBe(0.75);
    });

    it('should score a standalone issue as zero rather than penalising it', () => {
      const orphan = node({ number: 1 });
      expect(specContinuity.score(orphan, context(orphan))).toBe(0);
    });

    it('should find siblings declared only on the children, not on the parent', () => {
      const spec = node({ number: 100 });
      const done = node({ number: 101, parentNumber: 100, status: 'completed' });
      const todo = node({ number: 102, parentNumber: 100 });

      expect(specContinuity.score(todo, context(spec, done, todo))).toBe(0.5);
    });
  });

  describe('readinessAge', () => {
    it('should rank the older issue higher', () => {
      const old = node({ number: 47, createdAt: '2026-07-31T21:25:09Z' });
      const fresh = node({ number: 300, createdAt: '2026-08-19T10:00:00Z' });
      const ctx = context(old, fresh);

      expect(readinessAge.score(old, ctx)).toBeGreaterThan(readinessAge.score(fresh, ctx));
    });

    it('should sort an unparseable creation time last instead of first', () => {
      const undated = node({ number: 1, createdAt: '' });
      const dated = node({ number: 2 });
      const ctx = context(undated, dated);

      expect(readinessAge.score(undated, ctx)).toBeLessThan(readinessAge.score(dated, ctx));
    });
  });

  describe('lowestIssueNumber', () => {
    it('should rank the lower issue number higher', () => {
      const a = node({ number: 12 });
      const b = node({ number: 300 });
      const ctx = context(a, b);

      expect(lowestIssueNumber.score(a, ctx)).toBeGreaterThan(lowestIssueNumber.score(b, ctx));
    });
  });
});

describe('sortByPriority', () => {
  it('should put unblocking power ahead of every other criterion', () => {
    const blocker = node({ number: 300, dependents: [301], createdAt: '2026-08-19T10:00:00Z' });
    const blocked = node({ number: 301, status: 'blocked' });
    const oldStandalone = node({ number: 35, createdAt: '2026-07-31T14:32:21Z' });
    const ctx = context(blocker, blocked, oldStandalone);

    expect(sortByPriority([oldStandalone, blocker], ctx).map((n) => n.issue.number)).toEqual([
      300, 35,
    ]);
  });

  it('should finish the spec that is closest to done before starting a fresh one', () => {
    const nearlyDone = node({ number: 100, children: [101, 102] });
    const done = node({ number: 101, parentNumber: 100, status: 'completed' });
    const lastTicket = node({ number: 102, parentNumber: 100, createdAt: '2026-08-19T10:00:00Z' });

    const fresh = node({ number: 200, children: [201] });
    const freshTicket = node({ number: 201, parentNumber: 200, createdAt: '2026-07-01T10:00:00Z' });

    const ctx = context(nearlyDone, done, lastTicket, fresh, freshTicket);

    expect(sortByPriority([freshTicket, lastTicket], ctx).map((n) => n.issue.number)).toEqual([
      102, 201,
    ]);
  });

  it('should schedule the oldest issue first once the earlier tiers tie', () => {
    const newest = node({ number: 303, createdAt: '2026-08-20T10:00:00Z' });
    const oldest = node({ number: 35, createdAt: '2026-07-31T14:32:21Z' });
    const middle = node({ number: 148, createdAt: '2026-08-11T11:14:24Z' });
    const ctx = context(newest, oldest, middle);

    expect(sortByPriority([newest, middle, oldest], ctx).map((n) => n.issue.number)).toEqual([
      35, 148, 303,
    ]);
  });

  it('should produce the same order regardless of the order the nodes arrived in', () => {
    const a = node({ number: 10, createdAt: '2026-08-01T00:00:00Z' });
    const b = node({ number: 11, createdAt: '2026-08-01T00:00:00Z' });
    const c = node({ number: 12, createdAt: '2026-08-01T00:00:00Z' });
    const ctx = context(a, b, c);

    expect(sortByPriority([c, a, b], ctx).map((n) => n.issue.number)).toEqual([10, 11, 12]);
    expect(sortByPriority([b, c, a], ctx).map((n) => n.issue.number)).toEqual([10, 11, 12]);
  });
});

describe('explainPriority', () => {
  it('should report the score behind each tier in order', () => {
    const blocker = node({ number: 300, dependents: [301], createdAt: '2026-08-19T10:00:00Z' });
    const blocked = node({ number: 301, status: 'blocked' });

    expect(explainPriority(blocker, context(blocker, blocked))).toEqual([
      { name: 'unblockingPower', score: 1 },
      { name: 'specContinuity', score: 0 },
      { name: 'readinessAge', score: -Date.parse('2026-08-19T10:00:00Z') },
      { name: 'lowestIssueNumber', score: -300 },
    ]);
  });
});
