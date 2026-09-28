import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Orchestrator } from '../src/pipeline/orchestrator.js';
import { AutoPilotConfigSchema } from '../src/config/schema.js';
import { Notifier } from '../src/notifications/notifier.js';
import { AgentEventBus } from '../src/events/bus.js';
import type { GitHubIssue } from '../src/types/index.js';

describe('Orchestrator Manual Issue Enqueueing', () => {
  let orchestrator: Orchestrator;

  beforeEach(() => {
    Notifier.removeAllListeners();
    AgentEventBus.getInstance().clearHistory();

    const config = AutoPilotConfigSchema.parse({
      repository: 'owner/repo',
      maxConcurrency: 2,
      remote: {
        enabled: false,
      },
    });

    orchestrator = new Orchestrator(config);
  });

  afterEach(() => {
    if (orchestrator) {
      orchestrator.stop();
    }
    Notifier.removeAllListeners();
    vi.restoreAllMocks();
  });

  it('enqueues an unblocked task into priority queue and returns success', async () => {
    const issues: GitHubIssue[] = [
      {
        number: 10,
        title: 'Feature A',
        body: 'Implement Feature A',
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/10',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    orchestrator.getDAG().build(issues);

    const result = await orchestrator.enqueueTask(10);
    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBeFalsy();
    expect(orchestrator.getPriorityQueue()).toContain(10);
  });

  describe('--now (extra worker slot)', () => {
    const readyIssue = (number: number): GitHubIssue => ({
      number,
      title: `Feature ${number}`,
      body: '',
      state: 'OPEN',
      labels: [{ name: 'ready-for-agent' }],
      url: `https://github.com/owner/repo/issues/${number}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    it('should grant a pending burst slot to the enqueued issue', async () => {
      orchestrator.getDAG().build([readyIssue(10)]);

      const result = await orchestrator.enqueueTask(10, { now: true });

      expect(result.success).toBe(true);
      expect(result.message).toContain('extra worker slot');
      expect(orchestrator.getBurstSlots().pending).toEqual([10]);
    });

    it('should not grant a slot unless asked', async () => {
      orchestrator.getDAG().build([readyIssue(10)]);

      await orchestrator.enqueueTask(10);

      expect(orchestrator.getBurstSlots().pending).toEqual([]);
    });

    it('should exempt a running burst task from the concurrency ceiling', () => {
      const active = (orchestrator as any).activeTaskNumbers as Set<number>;
      const burstRunning = (orchestrator as any).burstTaskNumbers as Set<number>;

      expect(orchestrator.getAvailableSlots()).toBe(2);

      active.add(1);
      active.add(2);
      expect(orchestrator.getAvailableSlots()).toBe(0);

      // A third task dispatched on a burst slot must not consume one of the two normal slots
      active.add(3);
      burstRunning.add(3);
      expect(orchestrator.getAvailableSlots()).toBe(0);

      // The ceiling returns on its own when the burst task ends
      active.delete(3);
      burstRunning.delete(3);
      active.delete(2);
      expect(orchestrator.getAvailableSlots()).toBe(1);
    });

    it('should add a slot to an issue that is already queued', async () => {
      orchestrator.getDAG().build([readyIssue(10)]);

      await orchestrator.enqueueTask(10);
      const result = await orchestrator.enqueueTask(10, { now: true });

      expect(result.success).toBe(true);
      expect(orchestrator.getBurstSlots().pending).toEqual([10]);
      expect(orchestrator.getPriorityQueue().filter((n) => n === 10)).toHaveLength(1);
    });

    it('should still refuse a plain repeat of an already queued issue', async () => {
      orchestrator.getDAG().build([readyIssue(10)]);

      await orchestrator.enqueueTask(10);
      const result = await orchestrator.enqueueTask(10);

      expect(result.success).toBe(false);
      expect(result.message).toContain('already in the priority queue');
    });
  });

  describe('--runner (runner override)', () => {
    const readyIssue = (number: number, labels: { name: string }[] = [{ name: 'ready-for-agent' }]): GitHubIssue => ({
      number,
      title: `Feature ${number}`,
      body: '',
      state: 'OPEN',
      labels,
      url: `https://github.com/owner/repo/issues/${number}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    it('should record the override for the enqueued issue', async () => {
      orchestrator.getDAG().build([readyIssue(10)]);

      const result = await orchestrator.enqueueTask(10, { runner: 'agy' });

      expect(result.success).toBe(true);
      expect(result.message).toContain('agy');
      expect(orchestrator.getRunnerOverrides()).toEqual({ 10: 'agy' });
    });

    it('should win over the runner label on the issue', async () => {
      orchestrator.getDAG().build([
        readyIssue(10, [{ name: 'ready-for-agent' }, { name: 'runner:claude' }]),
      ]);

      await orchestrator.enqueueTask(10, { runner: 'agy' });

      expect((orchestrator as any).runnerFor(orchestrator.getDAG().getNode(10)!.issue)).toBe('agy');
    });

    it('should refuse a runner that is not registered', async () => {
      orchestrator.getDAG().build([readyIssue(10)]);

      const result = await orchestrator.enqueueTask(10, { runner: 'gpt5' });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Unknown or disallowed runner');
      expect(orchestrator.getPriorityQueue()).not.toContain(10);
    });
  });

  it('detects blocked issues and requires confirmation without force flag', async () => {
    const issues: GitHubIssue[] = [
      {
        number: 20,
        title: 'Blocker task',
        body: '',
        state: 'OPEN',
        labels: [],
        url: 'https://github.com/owner/repo/issues/20',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        number: 21,
        title: 'Dependent task',
        body: '',
        blockedBy: [{ number: 20 }],
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/21',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    orchestrator.getDAG().build(issues);

    const resWithoutForce = await orchestrator.enqueueTask(21);
    expect(resWithoutForce.success).toBe(false);
    expect(resWithoutForce.requiresConfirmation).toBe(true);
    expect(resWithoutForce.blockerNumbers).toEqual([20]);
    expect(orchestrator.getPriorityQueue()).not.toContain(21);

    const resWithForce = await orchestrator.enqueueTask(21, { force: true });
    expect(resWithForce.success).toBe(true);
    expect(orchestrator.getPriorityQueue()).toContain(21);
  });

  it('detects parent specs with child tickets and requires confirmation without force', async () => {
    const issues: GitHubIssue[] = [
      {
        number: 100,
        title: 'Parent Spec Feature',
        body: '',
        subIssues: [{ number: 101 }, { number: 102 }],
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/100',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        number: 101,
        title: 'Child Task 1',
        body: 'Part of #100',
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/101',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        number: 102,
        title: 'Child Task 2',
        body: 'Part of #100',
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/102',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    orchestrator.getDAG().build(issues);

    const resWithoutForce = await orchestrator.enqueueTask(100);
    expect(resWithoutForce.success).toBe(false);
    expect(resWithoutForce.requiresConfirmation).toBe(true);
    expect(resWithoutForce.isSpec).toBe(true);
    expect(resWithoutForce.childNumbers).toEqual([101, 102]);

    const resWithForce = await orchestrator.enqueueTask(100, { force: true });
    expect(resWithForce.success).toBe(true);
    expect(orchestrator.getPriorityQueue()).toContain(101);
    expect(orchestrator.getPriorityQueue()).toContain(102);
  });

  it('warns when an issue is closed and enqueues when force is true', async () => {
    const issues: GitHubIssue[] = [
      {
        number: 50,
        title: 'Closed Task',
        body: 'Already done',
        state: 'CLOSED',
        labels: [],
        url: 'https://github.com/owner/repo/issues/50',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    orchestrator.getDAG().build(issues);

    const resWithoutForce = await orchestrator.enqueueTask(50);
    expect(resWithoutForce.success).toBe(false);
    expect(resWithoutForce.requiresConfirmation).toBe(true);
    expect(resWithoutForce.isClosed).toBe(true);

    const resWithForce = await orchestrator.enqueueTask(50, { force: true });
    expect(resWithForce.success).toBe(true);
    expect(orchestrator.getPriorityQueue()).toContain(50);
  });

  it('fetches issue on demand from GitHub if missing from local DAG cache', async () => {
    const fetchedIssue: GitHubIssue = {
      number: 99,
      title: 'Newly created issue',
      body: 'Description',
      state: 'OPEN',
      labels: [{ name: 'ready-for-agent' }],
      url: 'https://github.com/owner/repo/issues/99',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const fetchSpy = vi.spyOn(orchestrator['gh'], 'fetchIssue').mockResolvedValue(fetchedIssue);

    const result = await orchestrator.enqueueTask(99);
    expect(fetchSpy).toHaveBeenCalledWith(99);
    expect(result.success).toBe(true);
    expect(orchestrator.getPriorityQueue()).toContain(99);
  });

  it('places priority queue items at the top of queued tasks in getTasksSummary', async () => {
    const issues: GitHubIssue[] = [
      {
        number: 1,
        title: 'Standard Ready Issue',
        body: '',
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        number: 2,
        title: 'Priority Enqueued Issue',
        body: '',
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }],
        url: 'https://github.com/owner/repo/issues/2',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    orchestrator.getDAG().build(issues);
    await orchestrator.enqueueTask(2);

    const summary = orchestrator.getTasksSummary();
    expect(summary.queued.length).toBe(2);
    expect(summary.queued[0].issueNumber).toBe(2);
    expect(summary.queued[1].issueNumber).toBe(1);
  });
});
