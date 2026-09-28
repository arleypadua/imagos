import type { DAGNode } from '../types/index.js';

/**
 * Scheduling order for ready nodes.
 *
 * Every criterion answers the same question — "how much sooner should this run?" — as a number
 * where **higher wins**. Criteria are applied lexicographically in {@link PRIORITY_CRITERIA} order:
 * the next one is consulted only to break a tie in the previous. They are deliberately not summed
 * into a single weighted score, because a weighted score needs magic constants nobody can tune and
 * makes "why did #12 beat #47?" unanswerable. A tier list answers it by naming the criterion.
 */

export interface PriorityContext {
  nodes: ReadonlyMap<number, DAGNode>;
}

export interface PriorityCriterion {
  name: string;
  score(node: DAGNode, ctx: PriorityContext): number;
}

export function createPriorityContext(nodes: ReadonlyMap<number, DAGNode>): PriorityContext {
  return { nodes };
}

/**
 * How much of the graph this node is holding up: the count of not-yet-completed issues that sit
 * transitively downstream of it. Draining a blocker that frees four tickets beats one that frees none.
 */
export const unblockingPower: PriorityCriterion = {
  name: 'unblockingPower',
  score(node, ctx) {
    const seen = new Set<number>([node.issue.number]);
    const queue = [...node.dependents];
    let count = 0;

    while (queue.length > 0) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);

      const dependent = ctx.nodes.get(next);
      if (!dependent) continue;
      if (dependent.status !== 'completed') count++;
      queue.push(...dependent.dependents);
    }

    return count;
  },
};

/**
 * How close this node's parent spec is to done, as a fraction of its tickets already completed.
 * A half-built spec is worth nothing, so finish one before starting the next. It also keeps the
 * concurrent workers inside one area of the tree, which cuts the rebase collisions between them.
 * Standalone issues score 0 and fall through to the next criterion.
 */
export const specContinuity: PriorityCriterion = {
  name: 'specContinuity',
  score(node, ctx) {
    if (node.parentNumber === undefined) return 0;

    const siblings = siblingsOf(node.parentNumber, ctx);
    if (siblings.length === 0) return 0;

    const completed = siblings.filter((s) => s.status === 'completed').length;
    return completed / siblings.length;
  },
};

/**
 * Age of the issue, oldest first. This is the fairness tier: without it the order is a LIFO and an
 * unlucky ticket starves forever behind newly filed ones.
 *
 * Ideally this measures how long the issue has been *ready* — when `ready-for-agent` was applied —
 * rather than when it was filed, so that an old issue triaged yesterday does not jump the queue.
 * That timestamp is not on the issue payload today, so creation time stands in for it. Issues
 * without a parseable creation time sort last rather than winning the tier by accident.
 */
export const readinessAge: PriorityCriterion = {
  name: 'readinessAge',
  score(node) {
    const createdAt = Date.parse(node.issue.createdAt);
    return Number.isNaN(createdAt) ? Number.NEGATIVE_INFINITY : -createdAt;
  },
};

/**
 * Lowest issue number, so that a tie between two issues filed in the same second still resolves the
 * same way on every poll. Without it the order falls back to whatever the GitHub API happened to
 * return, which is how newest-first became the de facto schedule in the first place.
 */
export const lowestIssueNumber: PriorityCriterion = {
  name: 'lowestIssueNumber',
  score(node) {
    return -node.issue.number;
  },
};

export const PRIORITY_CRITERIA: readonly PriorityCriterion[] = [
  unblockingPower,
  specContinuity,
  readinessAge,
  lowestIssueNumber,
];

/**
 * Sorts ready nodes into dispatch order. Each criterion is scored once per node and the resulting
 * tuples are compared, so adding a criterion costs one pass, not one walk per comparison.
 */
export function sortByPriority(
  nodes: DAGNode[],
  ctx: PriorityContext,
  criteria: readonly PriorityCriterion[] = PRIORITY_CRITERIA
): DAGNode[] {
  return nodes
    .map((node) => ({ node, scores: criteria.map((c) => c.score(node, ctx)) }))
    .sort((a, b) => compareScores(a.scores, b.scores))
    .map((scored) => scored.node);
}

/**
 * The scores behind a node's position, in tier order — for tests, `imagos backlog`, and answering
 * "why is this one running first?".
 */
export function explainPriority(
  node: DAGNode,
  ctx: PriorityContext,
  criteria: readonly PriorityCriterion[] = PRIORITY_CRITERIA
): { name: string; score: number }[] {
  return criteria.map((c) => ({ name: c.name, score: c.score(node, ctx) }));
}

function compareScores(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return b[i] - a[i];
  }
  return 0;
}

function siblingsOf(parentNumber: number, ctx: PriorityContext): DAGNode[] {
  const parent = ctx.nodes.get(parentNumber);
  const numbers = new Set<number>(parent?.children ?? []);

  for (const candidate of ctx.nodes.values()) {
    if (candidate.parentNumber === parentNumber) numbers.add(candidate.issue.number);
  }

  return Array.from(numbers)
    .map((n) => ctx.nodes.get(n))
    .filter((n): n is DAGNode => n !== undefined);
}
