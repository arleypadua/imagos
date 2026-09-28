import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RemoteControlManager } from '../src/remote/manager.js';
import type {
  RemoteControlProvider,
  RemoteMessageOptions,
  RemoteActionController,
  ActionContext,
} from '../src/remote/types.js';
import { Notifier } from '../src/notifications/notifier.js';
import { AgentEventBus } from '../src/events/bus.js';
import { QuotaMonitor } from '../src/quota/monitor.js';

class MockRemoteProvider implements RemoteControlProvider {
  public readonly name = 'mock';
  public isStarted = false;
  public sentMessages: Array<{ text: string; options?: RemoteMessageOptions }> = [];
  public editedMessages: Array<{ messageId: number; text: string; options?: RemoteMessageOptions }> = [];
  public actionHandlers: Map<
    string,
    (action: string, payload: string, userId: number, context?: ActionContext) => Promise<void>
  > = new Map();
  public textReplyHandlers: Array<(replyToMessageId: number, text: string, userId: number) => Promise<void>> = [];

  public commandHandlers: Map<
    string,
    (args: string[], userId: number, context?: ActionContext) => Promise<void>
  > = new Map();
  public allowedUserIds?: number[] = [123456, 789012];

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

  public onTextReply(
    handler: (replyToMessageId: number, text: string, userId: number) => Promise<void>
  ): void {
    this.textReplyHandlers.push(handler);
  }

  public onCommand(
    command: string,
    handler: (args: string[], userId: number, context?: ActionContext) => Promise<void>
  ): void {
    this.commandHandlers.set(command, handler);
  }

  public getAllowedUserIds(): number[] | undefined {
    return this.allowedUserIds;
  }

  public async triggerAction(
    payload: string,
    userId: number = 123,
    context?: ActionContext
  ): Promise<void> {
    for (const [prefix, handler] of this.actionHandlers.entries()) {
      if (payload.startsWith(prefix)) {
        await handler(prefix, payload, userId, context);
        break;
      }
    }
  }

  public async triggerTextReply(
    replyToMessageId: number,
    text: string,
    userId: number = 12345
  ): Promise<void> {
    for (const handler of this.textReplyHandlers) {
      await handler(replyToMessageId, text, userId);
    }
  }

  public async triggerCommand(
    command: string,
    args: string[] = [],
    userId: number = 123456,
    context?: ActionContext
  ): Promise<void> {
    const handler = this.commandHandlers.get(command.replace(/^\//, ''));
    if (handler) {
      await handler(args, userId, context);
    }
  }
}

class MockActionController implements RemoteActionController {
  public resumedRunners: Array<string | undefined> = [];
  public pausedTasks: number[] = [];
  public resumedTasks: number[] = [];
  public repliedNeedsInfo: Array<{ issueNumber: number; answer: string }> = [];
  public targetSpecs: number[][] = [];
  public isDispatchingPaused: boolean = false;

  public resumeQuota(runner?: string): void {
    this.resumedRunners.push(runner);
  }

  public async pauseTask(issueNumber: number): Promise<{ success: boolean; message: string }> {
    this.pausedTasks.push(issueNumber);
    return { success: true, message: `Paused worker for Issue #${issueNumber}` };
  }

  public async resumeTask(issueNumber: number): Promise<{ success: boolean; message: string }> {
    this.resumedTasks.push(issueNumber);
    return { success: true, message: `Resumed worker for Issue #${issueNumber}` };
  }

  public pauseDispatching(): { success: boolean; message: string } {
    this.isDispatchingPaused = true;
    return { success: true, message: 'Task dispatching paused.' };
  }

  public resumeDispatching(): { success: boolean; message: string } {
    this.isDispatchingPaused = false;
    return { success: true, message: 'Task dispatching resumed.' };
  }

  public async replyToNeedsInfo(issueNumber: number, answer: string): Promise<void> {
    this.repliedNeedsInfo.push({ issueNumber, answer });
  }

  public setTargetSpecs(specs: number[]): void {
    this.targetSpecs.push(specs);
  }

  public getStatusSummary(): unknown {
    return {
      daemonStatus: this.isDispatchingPaused ? 'idle' : 'running',
      status: this.isDispatchingPaused ? 'idle' : 'running',
      isSessionStarted: !this.isDispatchingPaused,
      isDispatchingPaused: this.isDispatchingPaused,
      activeWorkerCount: 1,
      maxConcurrency: 2,
      activeWorkers: [
        {
          issueNumber: 24,
          title: 'feat: notifications',
          branchName: 'agent/issue-24',
          runnerName: 'agy',
          status: 'running',
        },
      ],
      targetSpecs: this.targetSpecs[this.targetSpecs.length - 1] || [22],
      quota: { isPaused: false },
    };
  }

  public getTasksSummary(): any {
    return {
      inProgress: [
        {
          issueNumber: 24,
          title: 'feat: notifications',
          branchName: 'agent/issue-24',
          runnerName: 'agy',
          status: 'running',
        },
      ],
      paused: [
        {
          issueNumber: 25,
          title: 'feat: quota alert',
          branchName: 'agent/issue-25',
          runnerName: 'claude',
          status: 'paused_quota',
        },
      ],
      queued: [
        {
          issueNumber: 26,
          title: 'feat: needs info',
          runnerName: 'agy',
          status: 'ready',
        },
      ],
    };
  }

  public getSpecsSummary(): any {
    return {
      targetSpecs: this.targetSpecs[this.targetSpecs.length - 1] || [22],
      specs: [
        {
          number: 22,
          title: 'Epic: Remote Control',
          isComplete: false,
          totalTickets: 5,
          completedTickets: 3,
          state: 'OPEN',
        },
        {
          number: 10,
          title: 'Epic: Core Architecture',
          isComplete: true,
          totalTickets: 4,
          completedTickets: 4,
          state: 'CLOSED',
        },
      ],
    };
  }

  public getBrowseIssues(): any {
    return [
      { number: 30, title: 'bug: fix edge case' },
      { number: 22, title: 'Epic: Remote Control' },
      { number: 24, title: 'feat: notifications' },
      { number: 25, title: 'feat: quota alert' },
    ];
  }

  public getIssueTreeSummary(): any {
    return {
      specs: [
        {
          number: 22,
          title: 'Epic: Remote Control',
          isComplete: false,
          totalTickets: 3,
          completedTickets: 1,
          status: 'pending',
          children: [
            {
              number: 24,
              title: 'feat: notifications',
              status: 'ready',
              state: 'OPEN',
              isClosed: false,
            },
            {
              number: 25,
              title: 'feat: quota alert',
              status: 'ready',
              state: 'OPEN',
              isClosed: false,
            },
            {
              number: 23,
              title: 'feat: initial setup',
              status: 'completed',
              state: 'CLOSED',
              isClosed: true,
            },
          ],
        },
      ],
      standaloneIssues: [
        {
          number: 30,
          title: 'bug: fix edge case',
          status: 'ready',
          state: 'OPEN',
        },
      ],
      totalOpenSpecs: 1,
      totalOpenIssues: 3,
      readyIssueNumbers: [24, 25, 30],
    };
  }

  public async cleanWorktrees(): Promise<{ success: boolean; message: string; count: number }> {
    return { success: true, message: 'Cleaned up 2 inactive worktrees.', count: 2 };
  }

  public async getInspectSummary(issueNumber?: number): Promise<string> {
    return `Inspect summary for #${issueNumber ?? 24}:\n• Worktree: /path/to/worktree\n• Status: running`;
  }

  public async getLogsSummary(issueNumber: number, tailLines?: number): Promise<string> {
    return `Logs for #${issueNumber} (tail ${tailLines ?? 30}):\n[Info] Task running...`;
  }
}

describe('RemoteControlManager', () => {
  let provider: MockRemoteProvider;
  let actionController: MockActionController;
  let manager: RemoteControlManager;
  let eventBus: AgentEventBus;

  beforeEach(() => {
    Notifier.removeAllListeners();
    provider = new MockRemoteProvider();
    actionController = new MockActionController();
    eventBus = AgentEventBus.getInstance();
    eventBus.clearHistory();
  });

  afterEach(async () => {
    if (manager) {
      await manager.stop();
    }
    Notifier.removeAllListeners();
  });

  it('subscribes to Notifier events and dispatches formatted alerts tagged with [owner/repo]', async () => {
    manager = new RemoteControlManager({
      provider,
      repository: 'arleypadua/imagos',
      defaultChatId: 123456,
      eventBus,
      actionController,
    });

    await manager.start();
    expect(provider.isStarted).toBe(true);

    // 1. Task Started
    Notifier.notifyTaskStarted({
      issueNumber: 24,
      issueTitle: 'feat: outbound milestone notifications',
      runnerName: 'agy',
      branchName: 'agent/issue-24',
      sessionId: 'session-123',
    });

    expect(provider.sentMessages.length).toBe(1);
    expect(provider.sentMessages[0].options?.chatId).toBe(123456);
    expect(provider.sentMessages[0].text).toContain('[arleypadua/imagos] 🤖 *Task Started*: #24');
    expect(provider.sentMessages[0].text).toContain('• *Runner*: `agy`');

    // 2. Task Completed & Merged
    Notifier.notifyTaskMerged(
      24,
      'feat: outbound milestone notifications',
      'https://github.com/arleypadua/imagos/pull/30',
      30,
      'main'
    );

    expect(provider.sentMessages.length).toBe(2);
    expect(provider.sentMessages[1].text).toContain('[arleypadua/imagos] 🎉 *Task Completed & Merged*: #24');
    expect(provider.sentMessages[1].text).toContain('• *Pull Request*: [PR #30]');

    // 3. Spec Completed
    Notifier.notifySpecComplete(22, 'Spec: Extensible Remote Control');

    expect(provider.sentMessages.length).toBe(3);
    expect(provider.sentMessages[2].text).toContain('[arleypadua/imagos] 🏆 *Spec Complete*: #22');

    // 4. Needs Info / Feedback Needed
    Notifier.notifyNeedsFeedback(
      24,
      'feat: outbound milestone notifications',
      'Should we enable auto-retry by default?',
      'https://github.com/arleypadua/imagos/pull/30',
      30
    );

    expect(provider.sentMessages.length).toBe(4);
    expect(provider.sentMessages[3].text).toContain('[arleypadua/imagos] ❓ *Feedback Needed*: #24');
    expect(provider.sentMessages[3].text).toContain('Should we enable auto-retry by default?');

    // 5. Quota Paused (includes inline [⚡ Resume Immediately] action button)
    const resetTime = new Date('2026-08-20T19:00:00Z');
    Notifier.notifyQuotaPaused(resetTime, 45, 'claude');

    expect(provider.sentMessages.length).toBe(5);
    expect(provider.sentMessages[4].text).toContain('[arleypadua/imagos] ⏳ *Quota Limit Reached*');
    expect(provider.sentMessages[4].text).toContain('• *Runner*: `claude`');
    expect(provider.sentMessages[4].options?.actions).toBeDefined();
    expect(provider.sentMessages[4].options?.actions?.[0][0].label).toBe('⚡ Resume Immediately');
    expect(provider.sentMessages[4].options?.actions?.[0][0].payload).toBe('v1:q:res:claude');

    // 6. Quota Resumed
    Notifier.notifyQuotaResumed('claude');

    expect(provider.sentMessages.length).toBe(6);
    expect(provider.sentMessages[5].text).toContain('[arleypadua/imagos] ▶️ *Quota Resumed*');
  });

  it('listens to quota_paused and quota_resumed events from QuotaMonitor instance', async () => {
    const quotaMonitor = new QuotaMonitor();

    manager = new RemoteControlManager({
      provider,
      repository: 'arleypadua/imagos',
      defaultChatId: 123456,
      quotaMonitor,
      actionController,
    });

    await manager.start();

    const resetAt = new Date(Date.now() + 30 * 60 * 1000);
    quotaMonitor.triggerQuotaPause(resetAt, '5h session limit reached', 'agy');

    expect(provider.sentMessages.length).toBe(1);
    expect(provider.sentMessages[0].text).toContain('[arleypadua/imagos] ⏳ *Quota Limit Reached*');
    expect(provider.sentMessages[0].text).toContain('• *Runner*: `agy`');
    expect(provider.sentMessages[0].options?.actions?.[0][0].payload).toBe('v1:q:res:agy');

    quotaMonitor.resumeFromQuota('agy');

    expect(provider.sentMessages.length).toBe(2);
    expect(provider.sentMessages[1].text).toContain('[arleypadua/imagos] ▶️ *Quota Resumed*');
  });

  it('invokes RemoteActionController.resumeQuota and edits message inline when resume button is clicked', async () => {
    manager = new RemoteControlManager({
      provider,
      repository: 'arleypadua/imagos',
      defaultChatId: 123456,
      actionController,
    });

    await manager.start();

    const resetTime = new Date('2026-08-20T20:00:00Z');
    await manager.sendQuotaPaused({
      resetAt: resetTime,
      waitMinutes: 45,
      runnerName: 'claude',
    });

    expect(provider.sentMessages.length).toBe(1);
    const originalText = provider.sentMessages[0].text;

    // Simulate clicking the inline [⚡ Resume Immediately] button
    await provider.triggerAction('v1:q:res:claude', 111, {
      messageId: 1,
      chatId: 123456,
      originalText,
    });

    // 1. RemoteActionController was called with runner 'claude'
    expect(actionController.resumedRunners).toEqual(['claude']);

    // 2. Message was edited inline to remove buttons and display resume notice
    expect(provider.editedMessages.length).toBe(1);
    expect(provider.editedMessages[0].messageId).toBe(1);
    expect(provider.editedMessages[0].text).toContain(originalText);
    expect(provider.editedMessages[0].text).toContain('▶️ Resumed by developer at');
    expect(provider.editedMessages[0].options?.actions).toEqual([]);
  });

  it('handles quota resumption for all runners when runner is empty or all', async () => {
    manager = new RemoteControlManager({
      provider,
      repository: 'arleypadua/imagos',
      defaultChatId: 123456,
      actionController,
    });

    await manager.start();

    await provider.triggerAction('v1:q:res:', 111, {
      messageId: 2,
      chatId: 123456,
      originalText: 'Quota reached',
    });

    expect(actionController.resumedRunners).toEqual([undefined]);
    expect(provider.editedMessages.length).toBe(1);
  });

  it('enforces idempotency preventing double clicks on resume button', async () => {
    manager = new RemoteControlManager({
      provider,
      repository: 'arleypadua/imagos',
      defaultChatId: 123456,
      actionController,
    });

    await manager.start();

    const originalText = '[arleypadua/imagos] ⏳ *Quota Limit Reached*';

    // First click
    await provider.triggerAction('v1:q:res:claude', 111, {
      messageId: 10,
      chatId: 123456,
      originalText,
    });

    expect(actionController.resumedRunners).toEqual(['claude']);
    expect(provider.editedMessages.length).toBe(1);

    // Second click on the same message (e.g. rapid double tap or duplicate callback)
    await provider.triggerAction('v1:q:res:claude', 111, {
      messageId: 10,
      chatId: 123456,
      originalText,
    });

    // Still only 1 call to resumeQuota and 1 editMessage call
    expect(actionController.resumedRunners).toEqual(['claude']);
    expect(provider.editedMessages.length).toBe(1);
  });

  it('respects notification toggles to disable specific notifications', async () => {
    manager = new RemoteControlManager({
      provider,
      repository: 'arleypadua/imagos',
      defaultChatId: 123456,
      notifications: {
        taskCompleted: false,
        specCompleted: false,
        needsInfo: false,
        quotaPaused: false,
      },
    });

    await manager.start();

    Notifier.notifyTaskMerged(1, 'task title');
    Notifier.notifySpecComplete(2, 'spec title');
    Notifier.notifyNeedsFeedback(3, 'feedback title');
    Notifier.notifyQuotaPaused(new Date(), 30);
    Notifier.notifyQuotaResumed();

    expect(provider.sentMessages.length).toBe(0);
  });

  it('unsubscribes from all events on stop()', async () => {
    manager = new RemoteControlManager({
      provider,
      repository: 'arleypadua/imagos',
      defaultChatId: 123456,
    });

    await manager.start();
    expect(manager.isRunning()).toBe(true);

    Notifier.notifyTaskStarted({
      issueNumber: 1,
      issueTitle: 'task 1',
      runnerName: 'agy',
      branchName: 'branch-1',
    });
    expect(provider.sentMessages.length).toBe(1);

    await manager.stop();
    expect(manager.isRunning()).toBe(false);
    expect(provider.isStarted).toBe(false);

    Notifier.notifyTaskStarted({
      issueNumber: 2,
      issueTitle: 'task 2',
      runnerName: 'agy',
      branchName: 'branch-2',
    });
    expect(provider.sentMessages.length).toBe(1); // No new message sent
  });

  describe('needs-info dual-mode interactive steering', () => {
    it('automatically parses multiple-choice options and includes GitHub link button', async () => {
      manager = new RemoteControlManager({
        provider,
        repository: 'arleypadua/imagos',
        defaultChatId: 123456,
        actionController,
      });

      await manager.start();

      const question = `Which runner strategy should we use for this task?
1. Claude 3.7 Sonnet
2. Antigravity Agent (AGY)
3. Fallback Hybrid`;

      Notifier.notifyNeedsFeedback(
        26,
        'feat: remote needs-info steering',
        question,
        'https://github.com/arleypadua/imagos/pull/35',
        35
      );
      await new Promise((r) => setTimeout(r, 10));

      expect(provider.sentMessages.length).toBe(1);
      const msg = provider.sentMessages[0];
      expect(msg.text).toContain('Which runner strategy should we use for this task?');
      expect(msg.options?.actions).toBeDefined();

      const actions = msg.options!.actions!;
      // 3 choice buttons + 1 GitHub PR link button
      expect(actions.length).toBe(4);
      expect(actions[0][0].label).toBe('Claude 3.7 Sonnet');
      expect(actions[0][0].payload).toBe('v1:inf:26:0');
      expect(actions[1][0].label).toBe('Antigravity Agent (AGY)');
      expect(actions[1][0].payload).toBe('v1:inf:26:1');
      expect(actions[2][0].label).toBe('Fallback Hybrid');
      expect(actions[2][0].payload).toBe('v1:inf:26:2');
      expect(actions[3][0].label).toBe('🔗 Open on GitHub');
      expect(actions[3][0].url).toBe('https://github.com/arleypadua/imagos/pull/35');
    });

    it('handles option button click: acknowledges query, edits message with selection, removes buttons, and invokes actionController', async () => {
      manager = new RemoteControlManager({
        provider,
        repository: 'arleypadua/imagos',
        defaultChatId: 123456,
        actionController,
      });

      await manager.start();

      const question = `Which database should we use?
1. PostgreSQL
2. SQLite`;

      Notifier.notifyNeedsFeedback(26, 'feat: db migration', question);
      await new Promise((r) => setTimeout(r, 10));

      // Trigger button click on option 0 (PostgreSQL)
      await provider.triggerAction('v1:inf:26:0', 999);

      // Verify actionController received reply
      expect(actionController.repliedNeedsInfo.length).toBe(1);
      expect(actionController.repliedNeedsInfo[0]).toEqual({
        issueNumber: 26,
        answer: 'PostgreSQL',
      });

      // Verify message was edited to show selected choice and remove buttons
      expect(provider.editedMessages.length).toBe(1);
      const edited = provider.editedMessages[0];
      expect(edited.messageId).toBe(1);
      expect(edited.text).toContain('✅ *Answered* (via button): PostgreSQL');
      expect(edited.options?.actions).toEqual([]);

      // Second click on the same issue is ignored (locked message)
      await provider.triggerAction('v1:inf:26:1', 999);
      expect(actionController.repliedNeedsInfo.length).toBe(1);
      expect(provider.editedMessages.length).toBe(1);
    });

    it('handles swipe-to-reply text response: maps message ID to issue, edits message with reply, removes buttons, and invokes actionController', async () => {
      manager = new RemoteControlManager({
        provider,
        repository: 'arleypadua/imagos',
        defaultChatId: 123456,
        actionController,
      });

      await manager.start();

      Notifier.notifyNeedsFeedback(
        42,
        'feat: custom configuration',
        'What should the port number and timeout be?'
      );
      await new Promise((r) => setTimeout(r, 10));

      const messageId = provider.sentMessages.length; // Message ID is 1

      // Developer swipes to reply to messageId 1
      await provider.triggerTextReply(messageId, 'Use port 8080 and 30s timeout', 999);

      // Verify actionController received reply
      expect(actionController.repliedNeedsInfo.length).toBe(1);
      expect(actionController.repliedNeedsInfo[0]).toEqual({
        issueNumber: 42,
        answer: 'Use port 8080 and 30s timeout',
      });

      // Verify message was edited to show text reply and lock buttons
      expect(provider.editedMessages.length).toBe(1);
      const edited = provider.editedMessages[0];
      expect(edited.messageId).toBe(messageId);
      expect(edited.text).toContain('✅ *Answered* (via text): Use port 8080 and 30s timeout');
      expect(edited.options?.actions).toEqual([]);

      // Second reply to the same message is ignored
      await provider.triggerTextReply(messageId, 'Another reply', 999);
      expect(actionController.repliedNeedsInfo.length).toBe(1);
      expect(provider.editedMessages.length).toBe(1);
    });

    it('ignores text replies to unknown message IDs', async () => {
      manager = new RemoteControlManager({
        provider,
        repository: 'arleypadua/imagos',
        defaultChatId: 123456,
        actionController,
      });

      await manager.start();

      // Swipe to reply to an unknown message ID (e.g. 9999)
      await provider.triggerTextReply(9999, 'Some reply', 123);

      expect(actionController.repliedNeedsInfo.length).toBe(0);
      expect(provider.editedMessages.length).toBe(0);
    });
  });

  describe('Slash Commands & Interactive Orchestrator Controls', () => {
    beforeEach(async () => {
      manager = new RemoteControlManager({
        provider,
        repository: 'arleypadua/imagos',
        defaultChatId: 123456,
        actionController,
      });
      await manager.start();
    });

    it('/status command returns global daemon health, active worker count, git branches, and target specs', async () => {
      await provider.triggerCommand('status', [], 123456);

      expect(provider.sentMessages.length).toBe(1);
      const msg = provider.sentMessages[0];
      expect(msg.options?.chatId).toBe(123456);
      expect(msg.text).toContain('[arleypadua/imagos] ⚡ *Imagos Daemon Status*');
      expect(msg.text).toContain('• *Health*: 🟢 Running (Dispatching Active)');
      expect(msg.text).toContain('• *Active Workers*: 1 / 2');
      expect(msg.text).toContain('• *Active Branches*:');
      expect(msg.text).toContain('  - #24 (agy): `agent/issue-24`');
      expect(msg.text).toContain('• *Target Specs*: #22');
      expect(msg.text).toContain('• *Quota*: ✅ Available');
    });

    it('/tasks command lists in-progress, paused, and queued tasks with inline pause/resume buttons', async () => {
      await provider.triggerCommand('tasks', [], 123456);

      expect(provider.sentMessages.length).toBe(1);
      const msg = provider.sentMessages[0];
      expect(msg.text).toContain('[arleypadua/imagos] 📋 *Task Execution Backlog*');
      expect(msg.text).toContain('▶️ *In-Progress Tasks*:');
      expect(msg.text).toContain('• *#24* - *feat: notifications*');
      expect(msg.text).toContain('⏸️ *Paused Tasks*:');
      expect(msg.text).toContain('• *#25* - *feat: quota alert*');
      expect(msg.text).toContain('⏳ *Queued Tasks*:');
      expect(msg.text).toContain('• *#26* - feat: needs info');

      const actions = msg.options?.actions;
      expect(actions).toBeDefined();
      expect(actions!.length).toBe(2);
      expect(actions![0][0].label).toBe('⏸️ Pause #24');
      expect(actions![0][0].payload).toBe('v1:t:pause:24');
      expect(actions![1][0].label).toBe('▶️ Resume #25');
      expect(actions![1][0].payload).toBe('v1:t:resume:25');
    });

    it('/pause without arguments pauses global task dispatching', async () => {
      expect(actionController.isDispatchingPaused).toBe(false);

      await provider.triggerCommand('pause', [], 123456);

      expect(actionController.isDispatchingPaused).toBe(true);
      expect(provider.sentMessages.length).toBe(1);
      expect(provider.sentMessages[0].text).toContain('[arleypadua/imagos] ⏸️ *Task Dispatching Paused*');
    });

    it('/resume without arguments resumes global task dispatching', async () => {
      actionController.isDispatchingPaused = true;

      await provider.triggerCommand('resume', [], 123456);

      expect(actionController.isDispatchingPaused).toBe(false);
      expect(provider.sentMessages.length).toBe(1);
      expect(provider.sentMessages[0].text).toContain('[arleypadua/imagos] ▶️ *Task Dispatching Resumed*');
    });

    it('/pause <issueNumber> pauses individual worker', async () => {
      await provider.triggerCommand('pause', ['24'], 123456);

      expect(actionController.pausedTasks).toEqual([24]);
      expect(provider.sentMessages.length).toBe(1);
      expect(provider.sentMessages[0].text).toContain('[arleypadua/imagos] ⏸️ Paused worker for Issue #24');
    });

    it('/resume <issueNumber> resumes individual worker', async () => {
      await provider.triggerCommand('resume', ['25'], 123456);

      expect(actionController.resumedTasks).toEqual([25]);
      expect(provider.sentMessages.length).toBe(1);
      expect(provider.sentMessages[0].text).toContain('[arleypadua/imagos] ▶️ Resumed worker for Issue #25');
    });

    it('/specs without arguments lists parent specs and current scope with action buttons', async () => {
      await provider.triggerCommand('specs', [], 123456);

      expect(provider.sentMessages.length).toBe(1);
      const msg = provider.sentMessages[0];
      expect(msg.text).toContain('[arleypadua/imagos] 🎯 *Parent Specifications*');
      expect(msg.text).toContain('*Current Target Scope*: #22');
      expect(msg.text).toContain('• 🏗️ *#22* - Epic: Remote Control (3/5 tickets)');
      expect(msg.text).toContain('• ✅ *#10* - Epic: Core Architecture (4/4 tickets)');

      const actions = msg.options?.actions;
      expect(actions).toBeDefined();
      expect(actions!.length).toBe(3);
      expect(actions![0][0].label).toBe('🎯 Scope to #22');
      expect(actions![0][0].payload).toBe('v1:s:set:22');
      expect(actions![1][0].label).toBe('🎯 Scope to #10');
      expect(actions![1][0].payload).toBe('v1:s:set:10');
      expect(actions![2][0].label).toBe('🌐 All Specs (Unscoped)');
      expect(actions![2][0].payload).toBe('v1:s:all');
    });

    it('/specs <id> and /specs all switches target spec scopes remotely', async () => {
      // 1. Switch to specific spec #22
      await provider.triggerCommand('specs', ['22'], 123456);
      expect(actionController.targetSpecs).toEqual([[22]]);
      expect(provider.sentMessages.length).toBe(1);
      expect(provider.sentMessages[0].text).toContain('Scoped to Spec(s): #22');

      // 2. Switch to multiple specs #22, #10
      await provider.triggerCommand('specs', ['22,', '10'], 123456);
      expect(actionController.targetSpecs).toEqual([[22], [22, 10]]);
      expect(provider.sentMessages.length).toBe(2);
      expect(provider.sentMessages[1].text).toContain('Scoped to Spec(s): #22, #10');

      // 3. Switch to all specs
      await provider.triggerCommand('specs', ['all'], 123456);
      expect(actionController.targetSpecs).toEqual([[22], [22, 10], []]);
      expect(provider.sentMessages.length).toBe(3);
      expect(provider.sentMessages[2].text).toContain('Scoped to all unblocked tasks (all specs)');
    });

    it('/help command returns available commands and whitelist security status', async () => {
      await provider.triggerCommand('help', [], 123456);

      expect(provider.sentMessages.length).toBe(1);
      const msg = provider.sentMessages[0];
      expect(msg.text).toContain('[arleypadua/imagos] 📖 *Imagos Remote Bot Help*');
      expect(msg.text).toContain('• `/status`');
      expect(msg.text).toContain('• `/tasks`');
      expect(msg.text).toContain('• `/pause [issue]`');
      expect(msg.text).toContain('• `/resume [issue]`');
      expect(msg.text).toContain('• `/specs [numbers|all]`');
      expect(msg.text).toContain('• `/help`');
      expect(msg.text).toContain('🔒 *Security Status*:');
      expect(msg.text).toContain('• *Authorization*: Authorized ✅');
      expect(msg.text).toContain('• *Whitelist*: Enabled (2 allowed users)');
      expect(msg.text).toContain('• *Telegram User ID*: `123456`');
    });

    it('handles interactive task button clicks (v1:t:pause / v1:t:resume) and edits message inline', async () => {
      // Tap pause button on task #24
      await provider.triggerAction('v1:t:pause:24', 123456, {
        messageId: 5,
        chatId: 123456,
      });

      expect(actionController.pausedTasks).toEqual([24]);
      expect(provider.editedMessages.length).toBe(1);
      expect(provider.editedMessages[0].messageId).toBe(5);
      expect(provider.editedMessages[0].text).toContain('Task Execution Backlog');

      // Tap resume button on task #25
      await provider.triggerAction('v1:t:resume:25', 123456, {
        messageId: 5,
        chatId: 123456,
      });

      expect(actionController.resumedTasks).toEqual([25]);
      expect(provider.editedMessages.length).toBe(2);
      expect(provider.editedMessages[1].messageId).toBe(5);
    });

    it('handles interactive spec button clicks (v1:s:set / v1:s:all) and edits message inline', async () => {
      // Tap scope to spec #22
      await provider.triggerAction('v1:s:set:22', 123456, {
        messageId: 8,
        chatId: 123456,
      });

      expect(actionController.targetSpecs).toEqual([[22]]);
      expect(provider.editedMessages.length).toBe(1);
      expect(provider.editedMessages[0].messageId).toBe(8);
      expect(provider.editedMessages[0].text).toContain('Parent Specifications');

      // Tap all specs button
      await provider.triggerAction('v1:s:all', 123456, {
        messageId: 8,
        chatId: 123456,
      });

      expect(actionController.targetSpecs).toEqual([[22], []]);
      expect(provider.editedMessages.length).toBe(2);
      expect(provider.editedMessages[1].messageId).toBe(8);
    });

    it('/clean command cleans inactive worktrees and replies with formatted count', async () => {
      await provider.triggerCommand('clean', [], 123456);

      expect(provider.sentMessages.length).toBe(1);
      const msg = provider.sentMessages[0];
      expect(msg.text).toContain('🧹 *Clean Complete*');
      expect(msg.text).toContain('Cleaned up 2 inactive worktrees and temporary branches.');
    });

    it('/inspect <issue> returns diff summary and worker details', async () => {
      await provider.triggerCommand('inspect', ['24'], 123456);

      expect(provider.sentMessages.length).toBe(1);
      const msg = provider.sentMessages[0];
      expect(msg.text).toContain('🔍 *Inspection: Issue #24*');
      expect(msg.text).toContain('• Worktree: /path/to/worktree');
    });

    it('/inspect without arguments returns inspect usage help', async () => {
      await provider.triggerCommand('inspect', [], 123456);

      expect(provider.sentMessages.length).toBe(1);
      const msg = provider.sentMessages[0];
      expect(msg.text).toContain('🔍 *Inspect Task & Worker Sessions*');
      expect(msg.text).toContain('`/inspect 24`');
      expect(msg.text).toContain('`/inspect 25`');
      expect(msg.text).toContain('`/inspect 26`');
    });

    it('/logs <issue> returns recent logs formatted in code block', async () => {
      await provider.triggerCommand('logs', ['24'], 123456);

      expect(provider.sentMessages.length).toBe(1);
      const msg = provider.sentMessages[0];
      expect(msg.text).toContain('📜 *Logs: Issue #24*');
      expect(msg.text).toContain('[Info] Task running...');
    });

    it('/logs without arguments returns logs usage help', async () => {
      await provider.triggerCommand('logs', [], 123456);

      expect(provider.sentMessages.length).toBe(1);
      const msg = provider.sentMessages[0];
      expect(msg.text).toContain('📜 *Session Logs Usage*');
      expect(msg.text).toContain('`/logs 24`');
      expect(msg.text).toContain('`/logs 25`');
      expect(msg.text).toContain('`/logs 26`');
    });

    it('/browse command lists open issues by priority with number, title and link', async () => {
      await provider.triggerCommand('browse', [], 123456);

      expect(provider.sentMessages.length).toBe(1);
      const msg = provider.sentMessages[0];
      expect(msg.text).toContain('[arleypadua/imagos] 📋 *Issues by priority* (4) — page 1/1');
      expect(msg.text.split('\n').filter((l: string) => l.startsWith('[#'))).toEqual([
        '[#30](https://github.com/arleypadua/imagos/issues/30) bug: fix edge case',
        '[#22](https://github.com/arleypadua/imagos/issues/22) Epic: Remote Control',
        '[#24](https://github.com/arleypadua/imagos/issues/24) feat: notifications',
        '[#25](https://github.com/arleypadua/imagos/issues/25) feat: quota alert',
      ]);

      const actions = msg.options?.actions;
      expect(actions!.some((row) => row.some((b) => b.label.includes('GitHub Backlog')))).toBe(true);
      expect(actions!.some((row) => row.some((b) => b.payload.startsWith('v1:b:p:')))).toBe(false);
    });

    it('pages through issues in place when a navigation button is tapped', async () => {
      actionController.getBrowseIssues = () =>
        Array.from({ length: 12 }, (_, i) => ({ number: i + 1, title: `issue ${i + 1}` }));

      await provider.triggerCommand('browse', [], 123456);
      const first = provider.sentMessages[0];
      expect(first.text).toContain('page 1/2');
      expect(first.options?.actions?.[0]?.[0]?.payload).toBe('v1:b:p:2');

      await provider.triggerAction('v1:b:p:2', 123456, { messageId: 1, chatId: 123456 });

      expect(provider.editedMessages.length).toBe(1);
      const paged = provider.editedMessages[0];
      expect(paged.messageId).toBe(1);
      expect(paged.text).toContain('page 2/2');
      expect(paged.text).toContain('[#11](https://github.com/arleypadua/imagos/issues/11) issue 11');
      expect(paged.text).not.toContain('issue 10');
      expect(paged.options?.actions?.[0]?.[0]?.payload).toBe('v1:b:p:1');
    });
  });
});
