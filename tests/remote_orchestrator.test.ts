import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Orchestrator } from '../src/pipeline/orchestrator.js';
import { AutoPilotConfigSchema } from '../src/config/schema.js';
import { Notifier } from '../src/notifications/notifier.js';
import { AgentEventBus } from '../src/events/bus.js';
import type { RemoteControlProvider, RemoteMessageOptions, ActionContext } from '../src/remote/types.js';

class MockRemoteProvider implements RemoteControlProvider {
  public readonly name = 'mock';
  public isStarted = false;
  public sentMessages: Array<{ text: string; options?: RemoteMessageOptions }> = [];
  public editedMessages: Array<{ messageId: number; text: string; options?: RemoteMessageOptions }> = [];
  public actionHandlers: Map<
    string,
    (action: string, payload: string, userId: number, context?: ActionContext) => Promise<void>
  > = new Map();

  public async start(): Promise<void> {
    this.isStarted = true;
  }

  public async stop(): Promise<void> {
    this.isStarted = false;
  }

  public async sendMessage(
    text: string,
    options?: RemoteMessageOptions
  ): Promise<{ messageId: number }> {
    this.sentMessages.push({ text, options });
    return { messageId: this.sentMessages.length };
  }

  public async editMessage(
    messageId: number,
    text: string,
    options?: RemoteMessageOptions
  ): Promise<void> {
    this.editedMessages.push({ messageId, text, options });
  }

  public onAction(
    actionPrefix: string,
    handler: (action: string, payload: string, userId: number, context?: ActionContext) => Promise<void>
  ): void {
    this.actionHandlers.set(actionPrefix, handler);
  }

  public async triggerAction(
    payload: string,
    userId: number = 123,
    context?: ActionContext
  ): Promise<void> {
    for (const [prefix, handler] of this.actionHandlers.entries()) {
      if (payload.startsWith(prefix)) {
        await handler(prefix, payload, userId, context);
      }
    }
  }
}

describe('Orchestrator RemoteActionController & Quota Resumption', () => {
  let orchestrator: Orchestrator;

  beforeEach(() => {
    Notifier.removeAllListeners();
    AgentEventBus.getInstance().clearHistory();

    const config = AutoPilotConfigSchema.parse({
      repository: 'owner/repo',
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
  });

  it('resumes specific runner via resumeQuota(runner)', () => {
    const quotaMonitor = orchestrator.getQuotaMonitor();
    const resetAt = new Date(Date.now() + 60 * 60 * 1000);

    quotaMonitor.triggerQuotaPause(resetAt, 'Rate limited', 'claude');
    expect(quotaMonitor.isRunnerPaused('claude')).toBe(true);

    orchestrator.resumeQuota('claude');
    expect(quotaMonitor.isRunnerPaused('claude')).toBe(false);
  });

  it('resumes all runners via resumeQuota() without runner argument', () => {
    const quotaMonitor = orchestrator.getQuotaMonitor();
    const resetAt = new Date(Date.now() + 60 * 60 * 1000);

    quotaMonitor.triggerQuotaPause(resetAt, 'Rate limited', 'claude');
    quotaMonitor.triggerQuotaPause(resetAt, 'Rate limited', 'agy');

    expect(quotaMonitor.isRunnerPaused('claude')).toBe(true);
    expect(quotaMonitor.isRunnerPaused('agy')).toBe(true);

    orchestrator.resumeQuota();

    expect(quotaMonitor.isRunnerPaused('claude')).toBe(false);
    expect(quotaMonitor.isRunnerPaused('agy')).toBe(false);
  });

  it('provides getStatusSummary() with daemonStatus and quota information', () => {
    const summary = orchestrator.getStatusSummary() as any;
    expect(summary).toBeDefined();
    expect(summary.daemonStatus).toBeDefined();
    expect(summary.quota).toBeDefined();
    expect(summary.quota.isPaused).toBe(false);
  });

  it('integrates quota pause alert with remote action controller resumption', async () => {
    const provider = new MockRemoteProvider();

    const { RemoteControlManager } = await import('../src/remote/manager.js');
    const manager = new RemoteControlManager({
      provider,
      repository: 'owner/repo',
      defaultChatId: 555,
      actionController: orchestrator,
      quotaMonitor: orchestrator.getQuotaMonitor(),
    });

    await manager.start();

    // Trigger quota pause on Orchestrator's QuotaMonitor
    const resetAt = new Date(Date.now() + 45 * 60 * 1000);
    orchestrator.getQuotaMonitor().triggerQuotaPause(resetAt, '5h session limit reached', 'claude');

    expect(provider.sentMessages.length).toBe(1);
    expect(provider.sentMessages[0].text).toContain('[owner/repo] ⏳ *Quota Limit Reached*');
    expect(provider.sentMessages[0].text).toContain('• *Runner*: `claude`');
    expect(provider.sentMessages[0].options?.actions?.[0][0].label).toBe('⚡ Resume Immediately');
    expect(provider.sentMessages[0].options?.actions?.[0][0].payload).toBe('v1:q:res:claude');
    expect(orchestrator.getQuotaMonitor().isRunnerPaused('claude')).toBe(true);

    // Developer taps the button on Telegram
    await provider.triggerAction('v1:q:res:claude', 555, {
      messageId: 1,
      chatId: 555,
      originalText: provider.sentMessages[0].text,
    });

    // QuotaMonitor runner is resumed
    expect(orchestrator.getQuotaMonitor().isRunnerPaused('claude')).toBe(false);

    // Message is edited inline with resumption notice and removed buttons
    expect(provider.editedMessages.length).toBe(1);
    expect(provider.editedMessages[0].text).toContain('▶️ Resumed by developer at');
    expect(provider.editedMessages[0].options?.actions?.flat().map((b) => b.payload)).toEqual(['v1:n:status', 'v1:n:menu']);

    await manager.stop();
  });

  it('toggles task dispatching via pauseDispatching() and resumeDispatching()', () => {
    expect(orchestrator.isDispatchingPaused()).toBe(false);

    const pauseRes = orchestrator.pauseDispatching();
    expect(pauseRes.success).toBe(true);
    expect(orchestrator.isDispatchingPaused()).toBe(true);

    const resumeRes = orchestrator.resumeDispatching();
    expect(resumeRes.success).toBe(true);
    expect(orchestrator.isDispatchingPaused()).toBe(false);
  });

  it('provides getTasksSummary() and getSpecsSummary()', () => {
    const tasks = orchestrator.getTasksSummary();
    expect(tasks).toBeDefined();
    expect(Array.isArray(tasks.inProgress)).toBe(true);
    expect(Array.isArray(tasks.paused)).toBe(true);
    expect(Array.isArray(tasks.queued)).toBe(true);

    const specs = orchestrator.getSpecsSummary();
    expect(specs).toBeDefined();
    expect(Array.isArray(specs.targetSpecs)).toBe(true);
    expect(Array.isArray(specs.specs)).toBe(true);
  });
});
