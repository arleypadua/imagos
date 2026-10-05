import type { AutoPilotConfig, DAGNode, ExternalBlocker, GitHubIssue, TaskStatus } from '../types/index.js';
import { parseIssueDependencies } from './parser.js';
import { createPriorityContext, sortByPriority } from './priority.js';

/**
 * Whether a blocker in another repository still blocks. It isn't in this repository's issue set,
 * so its state comes from the relation itself; an unknown state counts as open.
 */
export function isExternalBlockerOpen(blocker: ExternalBlocker): boolean {
  return blocker.state !== 'CLOSED';
}

export function formatExternalBlocker(blocker: ExternalBlocker): string {
  return `${blocker.repository}#${blocker.number}`;
}

/** Every blocker of a node as a display reference, open or not: `#12` locally, `owner/repo#213` across repos. */
export function formatNodeBlockers(node: DAGNode): string[] {
  return [...node.blockers.map((id) => `#${id}`), ...node.externalBlockers.map(formatExternalBlocker)];
}

export class IssueDAG {
  private nodes: Map<number, DAGNode> = new Map();
  private config: AutoPilotConfig;

  constructor(config: Partial<AutoPilotConfig> = {}) {
    this.config = {
      baseBranch: 'main',
      runner: 'claude',
      pollIntervalSeconds: 10,
      maxConcurrency: 2,
      ...config,
      labels: {
        readyForAgent: 'ready-for-agent',
        needsInfo: 'needs-info',
        readyForHuman: 'ready-for-human',
        needsTriage: 'needs-triage',
        wontfix: 'wontfix',
        ...(config.labels || {}),
      },
    } as AutoPilotConfig;
  }

  public build(issues: GitHubIssue[]): void {
    this.nodes.clear();

    const issueMap = new Map<number, GitHubIssue>();
    for (const issue of issues) {
      issueMap.set(issue.number, issue);
    }

    // First pass: create all nodes
    for (const issue of issues) {
      const deps = parseIssueDependencies(issue);
      let runnerName = this.config.runner || 'claude';
      const allowed = this.config.allowedProviders || this.config.allowedRunners;
      if (issue.labels) {
        for (const label of issue.labels) {
          const match = label.name.match(/^(?:runner|agent):([a-zA-Z0-9_-]+)$/i);
          if (match && match[1]) {
            const requested = match[1].toLowerCase();
            if (!allowed || allowed.includes(requested)) {
              runnerName = requested;
            }
            break;
          }
        }
      }
      const node: DAGNode = {
        issue,
        kind: deps.kind,
        blockers: [...deps.blockers],
        externalBlockers: [...deps.externalBlockers],
        dependents: [],
        parentNumber: deps.parentNumber,
        children: [...deps.subTaskNumbers],
        status: 'pending',
        runnerName,
      };
      this.nodes.set(issue.number, node);
    }

    // Second pass: establish two-way relationships (parent/child)
    for (const [issueNumber, node] of this.nodes.entries()) {
      // Connect parent to children
      if (node.parentNumber) {
        const parentNode = this.nodes.get(node.parentNumber);
        if (parentNode) {
          if (!parentNode.children.includes(issueNumber)) {
            parentNode.children.push(issueNumber);
          }
          parentNode.kind = 'spec';
        }
      }

      // Connect children to parent
      for (const childId of node.children) {
        const childNode = this.nodes.get(childId);
        if (childNode) {
          if (childNode.parentNumber === undefined) {
            childNode.parentNumber = issueNumber;
          }
          if (childNode.kind !== 'spec') {
            childNode.kind = 'ticket';
          }
        }
      }

      if (node.children.length > 0) {
        node.kind = 'spec';
      }
    }

    // Propagate blockers from parent spec hierarchy down to child nodes
    const getAncestorBlockers = (startNode: DAGNode): { local: number[]; external: ExternalBlocker[] } => {
      const inheritedBlockers = new Set<number>();
      const inheritedExternal: ExternalBlocker[] = [];
      const visited = new Set<number>([startNode.issue.number]);
      let currentParentNumber = startNode.parentNumber;

      while (currentParentNumber !== undefined && !visited.has(currentParentNumber)) {
        visited.add(currentParentNumber);
        const parentNode = this.nodes.get(currentParentNumber);
        if (!parentNode) break;

        for (const bId of parentNode.blockers) {
          if (bId !== startNode.issue.number) {
            inheritedBlockers.add(bId);
          }
        }
        inheritedExternal.push(...parentNode.externalBlockers);

        currentParentNumber = parentNode.parentNumber;
      }

      return { local: Array.from(inheritedBlockers), external: inheritedExternal };
    };

    for (const node of this.nodes.values()) {
      const inherited = getAncestorBlockers(node);
      for (const bId of inherited.local) {
        if (!node.blockers.includes(bId)) {
          node.blockers.push(bId);
        }
      }
      for (const blocker of inherited.external) {
        const ref = formatExternalBlocker(blocker);
        if (!node.externalBlockers.some((b) => formatExternalBlocker(b) === ref)) {
          node.externalBlockers.push(blocker);
        }
      }
    }

    // Connect blockers to dependents
    for (const [issueNumber, node] of this.nodes.entries()) {
      for (const blockerId of node.blockers) {
        const blockerNode = this.nodes.get(blockerId);
        if (blockerNode && !blockerNode.dependents.includes(issueNumber)) {
          blockerNode.dependents.push(issueNumber);
        }
      }
    }

    // Third pass: evaluate status for each node
    for (const [issueNumber, node] of this.nodes.entries()) {
      node.status = this.evaluateStatus(node, issueMap);
    }
  }

  private evaluateStatus(node: DAGNode, issueMap: Map<number, GitHubIssue>): TaskStatus {
    const { issue } = node;

    if (issue.state === 'CLOSED') {
      return 'completed';
    }

    const labelNames = new Set(issue.labels.map((l) => l.name.toLowerCase()));
    const readyLabel = this.config.labels.readyForAgent.toLowerCase();
    const needsInfoLabel = this.config.labels.needsInfo.toLowerCase();
    const readyForHumanLabel = this.config.labels.readyForHuman.toLowerCase();
    const wontfixLabel = this.config.labels.wontfix.toLowerCase();

    if (labelNames.has(wontfixLabel)) {
      return 'completed'; // Treat wontfix as non-blocking terminal
    }

    const isHumanTask =
      labelNames.has(readyForHumanLabel) ||
      labelNames.has('human-task') ||
      labelNames.has('human-tasks') ||
      labelNames.has('human_task') ||
      labelNames.has('human');

    if (labelNames.has(needsInfoLabel) || isHumanTask) {
      return 'waiting_feedback';
    }

    if (!labelNames.has(readyLabel)) {
      return 'pending';
    }

    // Check blockers
    for (const blockerId of node.blockers) {
      const blockerIssue = issueMap.get(blockerId);
      // If blocker is missing or open, this task is blocked
      if (!blockerIssue || blockerIssue.state === 'OPEN') {
        return 'blocked';
      }
    }
    if (node.externalBlockers.some(isExternalBlockerOpen)) {
      return 'blocked';
    }

    return 'ready';
  }

  public getNode(issueNumber: number): DAGNode | undefined {
    return this.nodes.get(issueNumber);
  }

  public getAllNodes(): DAGNode[] {
    return Array.from(this.nodes.values());
  }

  public getSpecChildIssueNumbers(specNumber: number): number[] {
    const result = new Set<number>();
    const queue = [specNumber];
    const visited = new Set<number>([specNumber]);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const node = this.nodes.get(current);
      const directChildren = new Set<number>(node?.children || []);

      for (const n of this.nodes.values()) {
        if (n.parentNumber === current) {
          directChildren.add(n.issue.number);
        }
      }

      for (const childId of directChildren) {
        if (!visited.has(childId)) {
          visited.add(childId);
          result.add(childId);
          queue.push(childId);
        }
      }
    }

    return Array.from(result);
  }

  public isSpecComplete(specNumber: number): {
    isComplete: boolean;
    totalTickets: number;
    completedTickets: number;
    pendingTickets: number[];
  } {
    const childIds = this.getSpecChildIssueNumbers(specNumber);
    if (childIds.length === 0) {
      return { isComplete: false, totalTickets: 0, completedTickets: 0, pendingTickets: [] };
    }

    const leafTicketIds = childIds.filter((id) => {
      const node = this.nodes.get(id);
      return !node || (node.kind !== 'spec' && node.children.length === 0);
    });

    const targetList = leafTicketIds.length > 0 ? leafTicketIds : childIds;

    const pendingTickets: number[] = [];
    let completedTickets = 0;

    for (const id of targetList) {
      const node = this.nodes.get(id);
      if (!node || node.status !== 'completed') {
        pendingTickets.push(id);
      } else {
        completedTickets++;
      }
    }

    return {
      isComplete: pendingTickets.length === 0,
      totalTickets: targetList.length,
      completedTickets,
      pendingTickets,
    };
  }

  public getTargetSpecs(): number[] {
    if (this.config.targetSpecs && this.config.targetSpecs.length > 0) {
      return Array.from(new Set(this.config.targetSpecs));
    }
    if (this.config.targetSpec !== undefined) {
      const specs = Array.isArray(this.config.targetSpec)
        ? this.config.targetSpec
        : [this.config.targetSpec];
      return Array.from(new Set(specs));
    }
    return [];
  }

  public setTargetSpecs(specs: number[]): void {
    this.config.targetSpecs = specs;
    delete this.config.targetSpec;
  }

  public pruneCompletedTargetSpecs(): { removed: number[]; remaining: number[] } {
    const current = this.getTargetSpecs();
    if (current.length === 0) return { removed: [], remaining: [] };

    const removed: number[] = [];
    const remaining: number[] = [];

    for (const specNum of current) {
      const node = this.nodes.get(specNum);
      const isClosed = !node || node.issue.state === 'CLOSED';
      const specComplete = this.isSpecComplete(specNum);
      const isComplete = specComplete.isComplete;

      if (isClosed || isComplete) {
        removed.push(specNum);
      } else {
        remaining.push(specNum);
      }
    }

    if (removed.length > 0) {
      this.setTargetSpecs(remaining);
    }

    return { removed, remaining };
  }

  public getReadyNodes(): DAGNode[] {
    let nodes = this.getAllNodes().filter(
      (n: DAGNode) => n.status === 'ready' && n.kind !== 'spec' && n.children.length === 0
    );
    const targetSpecs = this.getTargetSpecs();

    if (targetSpecs.length > 0) {
      const childIds = new Set<number>();
      for (const specNumber of targetSpecs) {
        for (const childId of this.getSpecChildIssueNumbers(specNumber)) {
          childIds.add(childId);
        }
      }
      // Filter only nodes that belong to any of the target specs
      nodes = nodes.filter((n: DAGNode) => childIds.has(n.issue.number));
    }

    return sortByPriority(nodes, createPriorityContext(this.nodes));
  }

  public getOpenNodesByPriority(): DAGNode[] {
    const nodes = this.getAllNodes().filter((n: DAGNode) => n.issue.state === 'OPEN');
    return sortByPriority(nodes, createPriorityContext(this.nodes));
  }

  public getBlockedNodes(): DAGNode[] {
    let nodes = this.getAllNodes().filter((n: DAGNode) => n.status === 'blocked');
    const targetSpecs = this.getTargetSpecs();

    if (targetSpecs.length > 0) {
      const childIds = new Set<number>();
      for (const specNumber of targetSpecs) {
        for (const childId of this.getSpecChildIssueNumbers(specNumber)) {
          childIds.add(childId);
        }
      }
      nodes = nodes.filter((n: DAGNode) => childIds.has(n.issue.number));
    }

    return nodes;
  }

  public getWaitingFeedbackNodes(): DAGNode[] {
    let nodes = this.getAllNodes().filter((n: DAGNode) => n.status === 'waiting_feedback');
    const targetSpecs = this.getTargetSpecs();

    if (targetSpecs.length > 0) {
      const childIds = new Set<number>();
      for (const specNumber of targetSpecs) {
        for (const childId of this.getSpecChildIssueNumbers(specNumber)) {
          childIds.add(childId);
        }
        childIds.add(specNumber); // Also include the spec itself
      }
      nodes = nodes.filter((n: DAGNode) => childIds.has(n.issue.number));
    }

    return nodes;
  }

  public getTriageNodes(): DAGNode[] {
    let nodes = this.getAllNodes().filter((n: DAGNode) => n.status === 'pending');
    const targetSpecs = this.getTargetSpecs();

    if (targetSpecs.length > 0) {
      const childIds = new Set<number>();
      for (const specNumber of targetSpecs) {
        for (const childId of this.getSpecChildIssueNumbers(specNumber)) {
          childIds.add(childId);
        }
        childIds.add(specNumber); // Also include the spec itself
      }
      nodes = nodes.filter((n: DAGNode) => childIds.has(n.issue.number));
    }

    return nodes;
  }

  public getUnresolvedBlockers(issueNumber: number): number[] {
    const node = this.nodes.get(issueNumber);
    if (!node) return [];

    const unresolved: number[] = [];
    for (const blockerId of node.blockers) {
      const blockerNode = this.nodes.get(blockerId);
      if (!blockerNode || blockerNode.issue.state === 'OPEN') {
        unresolved.push(blockerId);
      }
    }
    return unresolved;
  }

  public getUnresolvedExternalBlockers(issueNumber: number): ExternalBlocker[] {
    const node = this.nodes.get(issueNumber);
    if (!node) return [];
    return node.externalBlockers.filter(isExternalBlockerOpen);
  }

  /**
   * Every open blocker of an issue as a display reference: `#12` for this repository's issues,
   * `owner/repo#213` for another repository's.
   */
  public getUnresolvedBlockerRefs(issueNumber: number): string[] {
    return [
      ...this.getUnresolvedBlockers(issueNumber).map((id) => `#${id}`),
      ...this.getUnresolvedExternalBlockers(issueNumber).map(formatExternalBlocker),
    ];
  }

  public updateRunnerConfig(config: Partial<AutoPilotConfig>): void {
    if (config.runner) {
      this.config.runner = config.runner;
    }
    if (config.allowedProviders !== undefined) {
      this.config.allowedProviders = config.allowedProviders;
    }
    if (config.allowedRunners !== undefined) {
      this.config.allowedRunners = config.allowedRunners;
    }

    const allowed = this.config.allowedProviders || this.config.allowedRunners;
    for (const node of this.nodes.values()) {
      if (node.status === 'pending' || node.status === 'blocked' || node.status === 'ready') {
        let runnerName = this.config.runner || 'claude';
        if (node.issue.labels) {
          for (const label of node.issue.labels) {
            const match = label.name.match(/^(?:runner|agent):([a-zA-Z0-9_-]+)$/i);
            if (match && match[1]) {
              const requested = match[1].toLowerCase();
              if (!allowed || allowed.includes(requested)) {
                runnerName = requested;
              }
              break;
            }
          }
        }
        node.runnerName = runnerName;
      }
    }
  }
}
