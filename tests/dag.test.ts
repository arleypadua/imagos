import { describe, it, expect } from 'vitest';
import { IssueDAG } from '../src/github/dag.js';
import { DEFAULT_CONFIG } from '../src/config/schema.js';
import { parseSpecsOption } from '../src/cli.js';
import type { GitHubIssue } from '../src/types/index.js';

describe('IssueDAG', () => {
  it('should correctly determine ready vs blocked tasks', () => {
    const issues: GitHubIssue[] = [
      {
        number: 1,
        title: 'Initial Database Schema',
        body: 'Create tables',
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/1',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 2,
        title: 'Add User API Endpoint',
        body: '',
        blockedBy: [{ number: 1 }],
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/2',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
    ];

    const dag = new IssueDAG(DEFAULT_CONFIG);
    dag.build(issues);

    const readyNodes = dag.getReadyNodes();
    const blockedNodes = dag.getBlockedNodes();

    expect(readyNodes.map((n) => n.issue.number)).toEqual([1]);
    expect(blockedNodes.map((n) => n.issue.number)).toEqual([2]);
    expect(dag.getUnresolvedBlockers(2)).toEqual([1]);
  });

  it('should unlock dependent task once blocker is closed', () => {
    const issues: GitHubIssue[] = [
      {
        number: 1,
        title: 'Initial Database Schema',
        body: 'Create tables',
        state: 'CLOSED',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/1',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 2,
        title: 'Add User API Endpoint',
        body: '',
        blockedBy: [{ number: 1 }],
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/2',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
    ];

    const dag = new IssueDAG(DEFAULT_CONFIG);
    dag.build(issues);

    const readyNodes = dag.getReadyNodes();
    expect(readyNodes.map((n) => n.issue.number)).toEqual([2]);
  });

  it('should mark tasks with needs-info, ready-for-human, or human-task as waiting_feedback', () => {
    const issues: GitHubIssue[] = [
      {
        number: 3,
        title: 'Configure OAuth Provider',
        body: 'Which provider should we use?',
        state: 'OPEN',
        labels: [{ name: 'needs-info' }],
        url: 'https://github.com/owner/repo/issues/3',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 4,
        title: 'PR Open for Review',
        body: 'Implemented but unmerged',
        state: 'OPEN',
        labels: [{ name: 'ready-for-human' }],
        url: 'https://github.com/owner/repo/issues/4',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 5,
        title: 'Manual 2FA hardware key setup',
        body: 'Must be done manually by admin',
        state: 'OPEN',
        labels: [{ name: 'human-task' }],
        url: 'https://github.com/owner/repo/issues/5',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
    ];

    const dag = new IssueDAG(DEFAULT_CONFIG);
    dag.build(issues);

    const feedbackNodes = dag.getWaitingFeedbackNodes();
    expect(feedbackNodes.map((n) => n.issue.number).sort()).toEqual([3, 4, 5]);
  });

  it('should scope execution strictly to a target spec and detect completion', () => {
    const issues: GitHubIssue[] = [
      {
        number: 50,
        title: '[Spec] User Billing Flow',
        body: '',
        subIssues: [{ number: 51 }, { number: 52 }],
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/50',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 51,
        title: 'Stripe webhook handler',
        body: '',
        parent: { number: 50 },
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/51',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 52,
        title: 'Invoice PDF generator',
        body: '',
        parent: { number: 50 },
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/52',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 99,
        title: 'Unrelated Standalone Bugfix',
        body: 'Fix css style',
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/99',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
    ];

    const dag = new IssueDAG({ ...DEFAULT_CONFIG, targetSpec: 50 });
    dag.build(issues);

    const readyNodes = dag.getReadyNodes();
    // Only #51 and #52 belong to spec 50; #99 is filtered out
    expect(readyNodes.map((n) => n.issue.number).sort()).toEqual([51, 52]);

    const initialCheck = dag.isSpecComplete(50);
    expect(initialCheck.isComplete).toBe(false);
    expect(initialCheck.totalTickets).toBe(2);

    // Simulate closing both tickets
    issues[1].state = 'CLOSED';
    issues[2].state = 'CLOSED';
    dag.build(issues);

    const completeCheck = dag.isSpecComplete(50);
    expect(completeCheck.isComplete).toBe(true);
    expect(completeCheck.completedTickets).toBe(2);
    expect(completeCheck.pendingTickets).toEqual([]);
  });

  it('should scope execution to multiple target specs', () => {
    const issues: GitHubIssue[] = [
      {
        number: 10,
        title: '[Spec] Auth Flow',
        body: '',
        subIssues: [{ number: 11 }, { number: 12 }],
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/10',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 11,
        title: 'Auth Login',
        body: '',
        parent: { number: 10 },
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/11',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 12,
        title: 'Auth Logout',
        body: '',
        parent: { number: 10 },
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/12',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 20,
        title: '[Spec] Payment Flow',
        body: '',
        subIssues: [{ number: 21 }],
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/20',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 21,
        title: 'Credit Card Charge',
        body: '',
        parent: { number: 20 },
        blockedBy: [{ number: 11 }],
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/21',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 99,
        title: 'Unrelated Standalone Task',
        body: 'Do something else',
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/99',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
    ];

    const dag = new IssueDAG({ ...DEFAULT_CONFIG, targetSpecs: [10, 20] });
    dag.build(issues);

    expect(dag.getTargetSpecs()).toEqual([10, 20]);

    const readyNodes = dag.getReadyNodes();
    // #11 and #12 are ready and belong to Spec 10; #21 is blocked by #11 (belongs to Spec 20); #99 is ignored
    expect(readyNodes.map((n) => n.issue.number).sort()).toEqual([11, 12]);

    const blockedNodes = dag.getBlockedNodes();
    expect(blockedNodes.map((n) => n.issue.number)).toEqual([21]);
  });

  it('should support targetSpec as an array in config', () => {
    const issues: GitHubIssue[] = [
      {
        number: 30,
        title: '[Spec] Spec A',
        body: '',
        subIssues: [{ number: 31 }],
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/30',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 31,
        title: 'Task A1',
        body: '',
        parent: { number: 30 },
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/31',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 40,
        title: '[Spec] Spec B',
        body: '',
        subIssues: [{ number: 41 }],
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/40',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 41,
        title: 'Task B1',
        body: '',
        parent: { number: 40 },
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/41',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
    ];

    const dag = new IssueDAG({ ...DEFAULT_CONFIG, targetSpec: [30, 40] });
    dag.build(issues);

    expect(dag.getTargetSpecs()).toEqual([30, 40]);
    const readyNodes = dag.getReadyNodes();
    expect(readyNodes.map((n) => n.issue.number).sort()).toEqual([31, 41]);
  });

  it('should detect completion for each spec independently when multiple specs exist', () => {
    const issues: GitHubIssue[] = [
      {
        number: 100,
        title: '[Spec] Feature 1',
        body: '',
        subIssues: [{ number: 101 }],
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/100',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 101,
        title: 'Task 1.1',
        body: '',
        parent: { number: 100 },
        state: 'CLOSED',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/101',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 200,
        title: '[Spec] Feature 2',
        body: '',
        subIssues: [{ number: 201 }],
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/200',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 201,
        title: 'Task 2.1',
        body: '',
        parent: { number: 200 },
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/201',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
    ];

    const dag = new IssueDAG({ ...DEFAULT_CONFIG, targetSpecs: [100, 200] });
    dag.build(issues);

    expect(dag.isSpecComplete(100).isComplete).toBe(true);
    expect(dag.isSpecComplete(200).isComplete).toBe(false);
  });

  it('should prune closed and completed specs from targetSpecs', () => {
    const issues: GitHubIssue[] = [
      {
        number: 100,
        title: '[Spec] Feature 1 (Done)',
        body: '',
        subIssues: [{ number: 101 }],
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/100',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 101,
        title: 'Task 1.1',
        body: '',
        parent: { number: 100 },
        state: 'CLOSED',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/101',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 200,
        title: '[Spec] Feature 2 (In progress)',
        body: '',
        subIssues: [{ number: 201 }],
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/200',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 201,
        title: 'Task 2.1',
        body: '',
        parent: { number: 200 },
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/201',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 300,
        title: '[Spec] Feature 3 (Closed issue)',
        body: '',
        subIssues: [{ number: 301 }],
        state: 'CLOSED',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/300',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 301,
        title: 'Task 3.1',
        body: '',
        parent: { number: 300 },
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/301',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
    ];

    const dag = new IssueDAG({ ...DEFAULT_CONFIG, targetSpecs: [100, 200, 300] });
    dag.build(issues);

    const result = dag.pruneCompletedTargetSpecs();
    expect(result.removed.sort()).toEqual([100, 300]);
    expect(result.remaining).toEqual([200]);
    expect(dag.getTargetSpecs()).toEqual([200]);

    // Close #201 and prune again
    issues[3].state = 'CLOSED';
    dag.build(issues);

    const result2 = dag.pruneCompletedTargetSpecs();
    expect(result2.removed).toEqual([200]);
    expect(result2.remaining).toEqual([]);
    expect(dag.getTargetSpecs()).toEqual([]);
  });

  it('should mark all children of a spec as blocked if the spec is blocked by another ticket', () => {
    const issues: GitHubIssue[] = [
      {
        number: 5,
        title: 'Core Infrastructure Setup',
        body: 'Set up base VPC and DB',
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/5',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 10,
        title: '[Spec] Auth System',
        body: '',
        blockedBy: [{ number: 5 }],
        subIssues: [{ number: 11 }, { number: 12 }],
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/10',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 11,
        title: 'Login endpoint',
        body: '',
        parent: { number: 10 },
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/11',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 12,
        title: 'Register endpoint',
        body: '',
        parent: { number: 10 },
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/12',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
    ];

    const dag = new IssueDAG(DEFAULT_CONFIG);
    dag.build(issues);

    const readyNodes = dag.getReadyNodes();
    const blockedNodes = dag.getBlockedNodes();

    // #5 is ready; #10, #11, #12 are blocked
    expect(readyNodes.map((n) => n.issue.number)).toEqual([5]);
    expect(blockedNodes.map((n) => n.issue.number).sort()).toEqual([10, 11, 12]);

    // Children inherit #5 in their blocker list and unresolved blockers
    const node11 = dag.getNode(11);
    const node12 = dag.getNode(12);
    expect(node11?.blockers).toContain(5);
    expect(node12?.blockers).toContain(5);
    expect(dag.getUnresolvedBlockers(11)).toEqual([5]);
    expect(dag.getUnresolvedBlockers(12)).toEqual([5]);

    // Blocker #5 has dependents [10, 11, 12]
    const blockerNode = dag.getNode(5);
    expect(blockerNode?.dependents.sort()).toEqual([10, 11, 12]);
  });

  it('should unblock spec children when the blocker ticket is closed', () => {
    const issues: GitHubIssue[] = [
      {
        number: 5,
        title: 'Core Infrastructure Setup',
        body: 'Set up base VPC and DB',
        state: 'CLOSED',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/5',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 10,
        title: '[Spec] Auth System',
        body: '',
        blockedBy: [{ number: 5 }],
        subIssues: [{ number: 11 }, { number: 12 }],
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/10',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 11,
        title: 'Login endpoint',
        body: '',
        parent: { number: 10 },
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/11',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 12,
        title: 'Register endpoint',
        body: '',
        parent: { number: 10 },
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/12',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
    ];

    const dag = new IssueDAG(DEFAULT_CONFIG);
    dag.build(issues);

    expect(dag.getNode(10)?.status).toBe('ready');

    const readyNodes = dag.getReadyNodes();
    expect(readyNodes.map((n) => n.issue.number).sort()).toEqual([11, 12]);
    expect(dag.getBlockedNodes()).toEqual([]);
  });

  it('should combine direct blockers and parent spec blockers on a child ticket', () => {
    const issues: GitHubIssue[] = [
      {
        number: 5,
        title: 'Spec Blocker',
        body: 'Spec blocker issue',
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/5',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 7,
        title: 'Child Direct Blocker',
        body: 'Direct blocker issue',
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/7',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 10,
        title: '[Spec] Feature',
        body: '',
        blockedBy: [{ number: 5 }],
        subIssues: [{ number: 11 }],
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/10',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 11,
        title: 'Feature Task',
        body: '',
        parent: { number: 10 },
        blockedBy: [{ number: 7 }],
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/11',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
    ];

    const dag = new IssueDAG(DEFAULT_CONFIG);
    dag.build(issues);

    const node11 = dag.getNode(11);
    expect(node11?.blockers.sort()).toEqual([5, 7]);
    expect(dag.getUnresolvedBlockers(11).sort()).toEqual([5, 7]);
    expect(node11?.status).toBe('blocked');

    // Close only spec blocker #5: #11 still blocked by #7
    issues[0].state = 'CLOSED';
    dag.build(issues);
    expect(dag.getNode(11)?.status).toBe('blocked');
    expect(dag.getUnresolvedBlockers(11)).toEqual([7]);

    // Close direct blocker #7: #11 is now ready
    issues[1].state = 'CLOSED';
    dag.build(issues);
    expect(dag.getNode(11)?.status).toBe('ready');
    expect(dag.getUnresolvedBlockers(11)).toEqual([]);
  });

  it('should recursively inherit blockers through nested spec hierarchies', () => {
    const issues: GitHubIssue[] = [
      {
        number: 1,
        title: 'Epic Blocker',
        body: 'Blocks root epic',
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/1',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 2,
        title: 'Sub-spec Blocker',
        body: 'Blocks sub-spec',
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/2',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 10,
        title: '[Spec] Root Epic',
        body: '',
        blockedBy: [{ number: 1 }],
        subIssues: [{ number: 20 }],
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/10',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 20,
        title: '[Spec] Sub Spec',
        body: '',
        parent: { number: 10 },
        blockedBy: [{ number: 2 }],
        subIssues: [{ number: 30 }],
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/20',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 30,
        title: 'Leaf Task',
        body: '',
        parent: { number: 20 },
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/30',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
    ];

    const dag = new IssueDAG(DEFAULT_CONFIG);
    dag.build(issues);

    const leafNode = dag.getNode(30);
    // Leaf node #30 inherits blocker #2 from parent spec #20 and #1 from grandparent spec #10
    expect(leafNode?.blockers.sort()).toEqual([1, 2]);
    expect(leafNode?.status).toBe('blocked');
    expect(dag.getUnresolvedBlockers(30).sort()).toEqual([1, 2]);
  });

  it('should block spec and its children when spec has native GitHub blockedBy', () => {
    const issues: GitHubIssue[] = [
      {
        number: 186,
        title: 'Spec: Hostname routing',
        body: 'Hostname routing spec',
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/186',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 187,
        title: 'Spec: Vite/React SSR',
        body: 'No blockers in text',
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/187',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
        blockedBy: [{ number: 186, title: 'Spec: Hostname routing', state: 'OPEN' }],
        subIssues: [{ number: 195, title: 'Upload static assets', state: 'OPEN' }],
      },
      {
        number: 195,
        title: 'Upload static assets',
        body: 'Subtask body',
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/195',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
        parent: { number: 187, title: 'Spec: Vite/React SSR' },
      },
    ];

    const dag = new IssueDAG(DEFAULT_CONFIG);
    dag.build(issues);

    const specNode = dag.getNode(187);
    const childNode = dag.getNode(195);

    expect(specNode?.status).toBe('blocked');
    expect(specNode?.blockers).toContain(186);

    expect(childNode?.status).toBe('blocked');
    expect(childNode?.blockers).toContain(186);

    expect(dag.getNode(186)?.status).toBe('ready');
    expect(dag.getReadyNodes()).toEqual([]);
    expect(dag.getBlockedNodes().map((n) => n.issue.number).sort()).toEqual([187, 195]);
  });

  it('should never offer a spec as a ready node, however it is titled or shaped', () => {
    const issues: GitHubIssue[] = [
      {
        number: 300,
        title: 'Spec: Scheduled functions',
        body: 'Acceptance criteria',
        subIssues: [{ number: 301 }],
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/300',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 301,
        title: 'A Schedule fires and the Function runs',
        body: '',
        parent: { number: 300 },
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/301',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 400,
        title: '[Spec] Hostname routing',
        body: 'Requirements',
        subIssues: [{ number: 401 }],
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/400',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 401,
        title: 'Resolve a tenant from the Host header',
        body: '',
        parent: { number: 400 },
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/401',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
    ];

    const dag = new IssueDAG(DEFAULT_CONFIG);
    dag.build(issues);

    expect(dag.getNode(300)?.kind).toBe('spec');
    expect(dag.getNode(400)?.kind).toBe('spec');
    expect(dag.getNode(300)?.status).toBe('ready');

    // Umbrella tickets stay out of dispatch even while they are otherwise ready
    expect(dag.getReadyNodes().map((n) => n.issue.number).sort()).toEqual([301, 401]);
  });

  it('should hand back ready nodes in dispatch order, not in the order GitHub returned them', () => {
    const issue = (number: number, blockedBy: number[], createdAt: string): GitHubIssue => ({
      number,
      title: `Issue ${number}`,
      body: '',
      blockedBy: blockedBy.map((n) => ({ number: n })),
      state: 'OPEN',
      labels: [{ name: 'ready-for-agent' }],
      url: `https://github.com/owner/repo/issues/${number}`,
      createdAt,
      updatedAt: createdAt,
    });

    // Newest first, the order the GraphQL query returns
    const issues: GitHubIssue[] = [
      issue(303, [302], '2026-08-20T10:00:00Z'),
      issue(302, [], '2026-08-19T10:00:00Z'),
      issue(148, [], '2026-08-11T11:14:24Z'),
      issue(35, [], '2026-07-31T14:32:21Z'),
    ];

    const dag = new IssueDAG(DEFAULT_CONFIG);
    dag.build(issues);

    // #302 is the newest ready issue but goes first because it unblocks #303;
    // the rest tie on every earlier tier and fall through to oldest-first
    expect(dag.getReadyNodes().map((n) => n.issue.number)).toEqual([302, 35, 148]);
  });

  it('should hand back every open node in priority order, including blocked ones and specs', () => {
    const issue = (number: number, blockedBy: number[], createdAt: string, state = 'OPEN'): GitHubIssue => ({
      number,
      title: `Issue ${number}`,
      body: '',
      blockedBy: blockedBy.map((n) => ({ number: n })),
      state: state as GitHubIssue['state'],
      labels: [{ name: 'ready-for-agent' }],
      url: `https://github.com/owner/repo/issues/${number}`,
      createdAt,
      updatedAt: createdAt,
    });

    const issues: GitHubIssue[] = [
      issue(303, [302], '2026-08-20T10:00:00Z'),
      issue(302, [], '2026-08-19T10:00:00Z'),
      issue(148, [], '2026-08-11T11:14:24Z'),
      issue(35, [], '2026-07-31T14:32:21Z', 'CLOSED'),
    ];

    const dag = new IssueDAG(DEFAULT_CONFIG);
    dag.build(issues);

    // #302 leads on unblocking power; #303 is blocked but still listed; the closed #35 is dropped
    expect(dag.getOpenNodesByPriority().map((n) => n.issue.number)).toEqual([302, 148, 303]);
  });

  it('should respect allowedProviders when assigning node.runnerName from issue labels', () => {
    const issues: GitHubIssue[] = [
      {
        number: 10,
        title: 'Task with agy label',
        body: 'Do something',
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }, { name: 'runner:agy' }],
        url: 'https://github.com/owner/repo/issues/10',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
    ];

    // Case 1: agy is allowed
    const dagAllowed = new IssueDAG({
      ...DEFAULT_CONFIG,
      runner: 'claude',
      allowedProviders: ['claude', 'agy'],
    });
    dagAllowed.build(issues);
    expect(dagAllowed.getNode(10)?.runnerName).toBe('agy');

    // Case 2: agy is NOT allowed -> falls back to default runner (claude)
    const dagDisallowed = new IssueDAG({
      ...DEFAULT_CONFIG,
      runner: 'claude',
      allowedProviders: ['claude'],
    });
    dagDisallowed.build(issues);
    expect(dagDisallowed.getNode(10)?.runnerName).toBe('claude');
  });

  it('should correctly return triage nodes and filter by target specs', () => {
    const issues: GitHubIssue[] = [
      {
        number: 1,
        title: 'Ready Ticket',
        body: 'Do ready work',
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/1',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 2,
        title: 'Needs Triage Ticket 1',
        body: 'Needs classification',
        state: 'OPEN',
        labels: [{ name: 'needs-triage' }],
        url: 'https://github.com/owner/repo/issues/2',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 3,
        title: 'Unlabeled Open Ticket',
        body: 'Just created',
        state: 'OPEN',
        labels: [],
        url: 'https://github.com/owner/repo/issues/3',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 50,
        title: '[Spec] Spec 50',
        body: '',
        subIssues: [{ number: 51 }],
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/50',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
      {
        number: 51,
        title: 'Spec Child Untriaged',
        body: '',
        parent: { number: 50 },
        state: 'OPEN',
        labels: [{ name: 'needs-triage' }],
        url: 'https://github.com/owner/repo/issues/51',
        createdAt: '2026-08-19T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
      },
    ];

    const unscopedDag = new IssueDAG(DEFAULT_CONFIG);
    unscopedDag.build(issues);
    expect(unscopedDag.getTriageNodes().map((n) => n.issue.number).sort()).toEqual([2, 3, 51]);

    const scopedDag = new IssueDAG({ ...DEFAULT_CONFIG, targetSpec: 50 });
    scopedDag.build(issues);
    expect(scopedDag.getTriageNodes().map((n) => n.issue.number)).toEqual([51]);
  });

  it('should never offer epics or nested specs as ready nodes and resolve child tickets recursively', () => {
    const issues: GitHubIssue[] = [
      {
        number: 376,
        title: 'Epic: Liability shield and operator controls',
        body: 'Top-level epic for operator restriction and liability compliance',
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/wawesomeio/wawesome-monorepo/issues/376',
        createdAt: '2026-08-24T10:00:00Z',
        updatedAt: '2026-08-24T10:00:00Z',
        subIssues: [{ number: 380, title: 'Spec: operator restriction', state: 'OPEN' }],
      },
      {
        number: 380,
        title: 'Spec: operator restriction — make a Function, App or Tenant unreachable, recorded',
        body: 'Spec for #376. Decisions were settled in a grilling session.',
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/wawesomeio/wawesome-monorepo/issues/380',
        createdAt: '2026-08-24T10:00:00Z',
        updatedAt: '2026-08-24T10:00:00Z',
        parent: { number: 376, title: 'Epic: Liability shield' },
        subIssues: [{ number: 381, title: 'Restrict and lift an App, recorded', state: 'OPEN' }],
      },
      {
        number: 381,
        title: 'Restrict and lift an App, recorded',
        body: '',
        parent: { number: 380 },
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/wawesomeio/wawesome-monorepo/issues/381',
        createdAt: '2026-08-24T10:00:00Z',
        updatedAt: '2026-08-24T10:00:00Z',
        parent: { number: 380, title: 'Spec: operator restriction' },
      },
    ];

    const dag = new IssueDAG(DEFAULT_CONFIG);
    dag.build(issues);

    // Verify kinds
    expect(dag.getNode(376)?.kind).toBe('spec');
    expect(dag.getNode(380)?.kind).toBe('spec');
    expect(dag.getNode(381)?.kind).toBe('ticket');

    // Only ticket #381 should be ready
    expect(dag.getReadyNodes().map((n) => n.issue.number)).toEqual([381]);

    // Recursive child resolution
    expect(dag.getSpecChildIssueNumbers(376).sort()).toEqual([380, 381]);
    expect(dag.getSpecChildIssueNumbers(380)).toEqual([381]);

    // Scoping to Epic 376 should only return leaf ticket 381
    const epicScopedDag = new IssueDAG({ ...DEFAULT_CONFIG, targetSpec: 376 });
    epicScopedDag.build(issues);
    expect(epicScopedDag.getReadyNodes().map((n) => n.issue.number)).toEqual([381]);

    // Scoping to Spec 380 should only return leaf ticket 381
    const specScopedDag = new IssueDAG({ ...DEFAULT_CONFIG, targetSpec: 380 });
    specScopedDag.build(issues);
    expect(specScopedDag.getReadyNodes().map((n) => n.issue.number)).toEqual([381]);
  });
});

describe('parseSpecsOption', () => {
  it('should parse single string number', () => {
    expect(parseSpecsOption('42')).toEqual([42]);
  });

  it('should parse comma-separated string numbers', () => {
    expect(parseSpecsOption('10, 20, 30')).toEqual([10, 20, 30]);
  });

  it('should accumulate values across multiple invocations and ignore non-numbers', () => {
    const prev = parseSpecsOption('10,20');
    const result = parseSpecsOption('30,invalid,40', prev);
    expect(result).toEqual([10, 20, 30, 40]);
  });

  it('should handle array inputs from variadic options', () => {
    expect(parseSpecsOption(['50', '60,70'])).toEqual([50, 60, 70]);
  });
});


