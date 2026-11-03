import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Orchestrator } from '../src/pipeline/orchestrator.js';
import { RemoteControlManager } from '../src/remote/manager.js';
import type { RemoteControlProvider, RemoteMessageOptions } from '../src/remote/types.js';
import type { AutoPilotConfig, DAGNode, GitHubIssue } from '../src/types/index.js';
import { AgentEventBus } from '../src/events/bus.js';
import { Notifier } from '../src/notifications/notifier.js';

vi.mock('../src/github/client.js');
vi.mock('../src/worktree/manager.js');
vi.mock('../src/runners/facade.js');

class MockRemoteProvider implements RemoteControlProvider {
  public readonly name = 'mock';
  public isStarted = false;
  public sentMessages: Array<{ text: string; options?: RemoteMessageOptions }> = [];
  public editedMessages: Array<{ messageId: number; text: string; options?: RemoteMessageOptions }> = [];
  public actionHandlers: Map<string, (action: string, payload: string, userId: number) => Promise<void>> = new Map();
  public textReplyHandlers: Array<(replyToMessageId: number, text: string, userId: number) => Promise<void>> = [];

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
    handler: (action: string, payload: string, userId: number) => Promise<void>
  ): void {
    this.actionHandlers.set(actionPrefix, handler);
  }

  public onTextReply(
    handler: (replyToMessageId: number, text: string, userId: number) => Promise<void>
  ): void {
    this.textReplyHandlers.push(handler);
  }

  public async triggerAction(payload: string, userId: number = 12345): Promise<void> {
    for (const [prefix, handler] of this.actionHandlers.entries()) {
      if (payload.startsWith(prefix)) {
        await handler(prefix, payload, userId);
        break;
      }
    }
  }

  public async triggerTextReply(replyToMessageId: number, text: string, userId: number = 12345): Promise<void> {
    for (const handler of this.textReplyHandlers) {
      await handler(replyToMessageId, text, userId);
    }
  }
}

describe('Remote Needs-Info Steering & Dual-Mode Replies', () => {
  let config: AutoPilotConfig;
  let orchestrator: Orchestrator;
  let provider: MockRemoteProvider;
  let remoteManager: RemoteControlManager;
  let eventBus: AgentEventBus;
  let mockGh: any;
  let mockWorktreeMgr: any;
  let mockRunnerFacade: any;

  beforeEach(() => {
    vi.clearAllMocks();
    Notifier.removeAllListeners();

    eventBus = AgentEventBus.getInstance();
    eventBus.clearHistory();

    provider = new MockRemoteProvider();

    config = {
      repository: 'arleypadua/imagos',
      baseBranch: 'main',
      maxConcurrency: 2,
      maxAutoNudges: 2,
      maxRetriesOnFailure: 2,
      pollIntervalSeconds: 10,
      runner: 'agy',
      autoMerge: true,
      mergeMethod: 'squash',
      cleanupWorktreeOnClose: true,
      remote: {
        enabled: false,
        provider: 'telegram',
        telegram: {
          botTokenEnv: 'TOKEN',
          notifications: {
            needsInfo: true,
            quotaPaused: true,
            taskCompleted: true,
            specCompleted: true,
          },
        },
      },
      quota: { pauseOnLimit: true, utilizationThreshold: 0.85, proxyPort: 9876 },
      labels: {
        readyForAgent: 'ready-for-agent',
        needsInfo: 'needs-info',
        readyForHuman: 'ready-for-human',
        needsTriage: 'needs-triage',
        wontfix: 'wontfix',
      },
    };

    orchestrator = new Orchestrator(config);

    mockGh = (orchestrator as any).gh;
    mockWorktreeMgr = (orchestrator as any).worktreeMgr;
    mockRunnerFacade = (orchestrator as any).runnerFacade;

    mockWorktreeMgr.worktreeExists.mockResolvedValue(true);
    mockWorktreeMgr.createWorktree.mockResolvedValue({
      worktreePath: '/tmp/worktree-26',
      branchName: 'agent/issue-26',
    });

    mockGh.addComment.mockResolvedValue({});
    mockGh.editIssueLabels.mockResolvedValue({});
    mockGh.viewIssue.mockResolvedValue({
      number: 26,
      title: 'feat: needs-info steering',
      state: 'OPEN',
      labels: [{ name: 'ready-for-agent' }],
    });
    mockGh.findPRForBranch.mockResolvedValue({
      number: 100,
      url: 'https://github.com/arleypadua/imagos/pull/100',
      state: 'OPEN',
    });
    mockGh.mergePR.mockResolvedValue({});
    mockGh.closeIssue.mockResolvedValue({});

    remoteManager = new RemoteControlManager({
      provider,
      repository: 'arleypadua/imagos',
      defaultChatId: 123456,
      eventBus,
      actionController: orchestrator,
    });
  });

  it('Orchestrator.replyToNeedsInfo posts GitHub comment, updates labels, and unblocks worktree task', async () => {
    const issue: GitHubIssue = {
      number: 26,
      title: 'feat: interactive needs-info steering',
      body: 'Task description',
      state: 'OPEN',
      labels: [{ name: 'needs-info' }, { name: 'ready-for-human' }],
      url: 'https://github.com/arleypadua/imagos/issues/26',
      createdAt: '2026-08-20T10:00:00Z',
      updatedAt: '2026-08-20T10:00:00Z',
    };

    const node: DAGNode = {
      issue,
      kind: 'ticket',
      blockers: [],
      dependents: [],
      children: [],
      status: 'waiting_feedback',
      runnerName: 'agy',
    };

    (orchestrator as any).dag.build([issue]);

    mockRunnerFacade.run.mockResolvedValue({
      success: true,
      status: 'COMPLETED',
    });

    let emittedEvent: any = null;
    eventBus.on('agent_event', (e) => {
      if (e.type === 'prompt_injected') {
        emittedEvent = e;
      }
    });

    await orchestrator.replyToNeedsInfo(26, 'Use Option B (PostgreSQL)');
    await new Promise((r) => setTimeout(r, 50));

    // 1. Verify GitHub comment posted
    expect(mockGh.addComment).toHaveBeenCalledWith(
      26,
      expect.stringContaining('💬 **Developer Response** (via Telegram):\n\nUse Option B (PostgreSQL)')
    );

    // 2. Verify GitHub labels updated
    expect(mockGh.editIssueLabels).toHaveBeenCalledWith(26, {
      add: ['ready-for-agent'],
      remove: ['ready-for-human', 'needs-info'],
    });

    // 3. Verify AgentEventBus event emitted
    expect(emittedEvent).toBeDefined();
    expect(emittedEvent.issueNumber).toBe(26);
    expect(emittedEvent.detail?.prompt).toBe('Use Option B (PostgreSQL)');

    // 4. Verify runner was dispatched with developer feedback in worktree
    expect(mockRunnerFacade.run).toHaveBeenCalledTimes(1);
    const runnerContext = mockRunnerFacade.run.mock.calls[0][0];
    expect(runnerContext.userFeedback).toBe('Use Option B (PostgreSQL)');
    expect(runnerContext.isContinuation).toBe(true);
  });

  it('Dual-mode signal propagation: tapping button triggers RemoteControlManager, locks message, and unblocks Orchestrator worktree', async () => {
    await remoteManager.start();

    const issue: GitHubIssue = {
      number: 26,
      title: 'feat: interactive needs-info steering',
      body: 'Task description',
      state: 'OPEN',
      labels: [{ name: 'needs-info' }],
      url: 'https://github.com/arleypadua/imagos/issues/26',
      createdAt: '2026-08-20T10:00:00Z',
      updatedAt: '2026-08-20T10:00:00Z',
    };

    (orchestrator as any).dag.build([issue]);

    mockRunnerFacade.run.mockResolvedValue({
      success: true,
      status: 'COMPLETED',
    });

    const question = `Which database should we use?
1. SQLite
2. PostgreSQL`;

    Notifier.notifyNeedsFeedback(26, 'feat: interactive needs-info steering', question);
    await new Promise((r) => setTimeout(r, 20));

    // Verify Telegram notification was sent with choice buttons
    expect(provider.sentMessages.length).toBe(1);
    const sentMsg = provider.sentMessages[0];
    expect(sentMsg.options?.actions).toBeDefined();
    expect(sentMsg.options?.actions?.[0][0].label).toBe('SQLite');
    expect(sentMsg.options?.actions?.[1][0].label).toBe('PostgreSQL');

    // Developer taps button for option 1 (PostgreSQL)
    await provider.triggerAction('v1:inf:26:1', 111);
    await new Promise((r) => setTimeout(r, 50));

    // Verify message was edited/locked on Telegram
    expect(provider.editedMessages.length).toBe(1);
    expect(provider.editedMessages[0].text).toContain('✅ *Answered* (via button): PostgreSQL');
    expect(provider.editedMessages[0].options?.actions?.flat().some((b) => b.payload.startsWith('v1:inf'))).toBe(false);

    // Verify GitHub comment posted
    expect(mockGh.addComment).toHaveBeenCalledWith(
      26,
      expect.stringContaining('💬 **Developer Response** (via Telegram):\n\nPostgreSQL')
    );

    // Verify runner execution unblocked
    expect(mockRunnerFacade.run).toHaveBeenCalledTimes(1);
    const runnerContext = mockRunnerFacade.run.mock.calls[0][0];
    expect(runnerContext.userFeedback).toBe('PostgreSQL');
  });

  it('Dual-mode signal propagation: swiping to reply with text maps message ID, locks message, and unblocks Orchestrator worktree', async () => {
    await remoteManager.start();

    const issue: GitHubIssue = {
      number: 42,
      title: 'feat: custom endpoint',
      body: 'Task description',
      state: 'OPEN',
      labels: [{ name: 'needs-info' }],
      url: 'https://github.com/arleypadua/imagos/issues/42',
      createdAt: '2026-08-20T10:00:00Z',
      updatedAt: '2026-08-20T10:00:00Z',
    };

    (orchestrator as any).dag.build([issue]);

    mockRunnerFacade.run.mockResolvedValue({
      success: true,
      status: 'COMPLETED',
    });

    Notifier.notifyNeedsFeedback(
      42,
      'feat: custom endpoint',
      'What should the base URL path be?'
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(provider.sentMessages.length).toBe(1);
    const messageId = provider.sentMessages.length; // 1

    // Developer replies via Telegram swipe-to-reply
    await provider.triggerTextReply(messageId, 'Use /api/v2/metrics', 111);
    await new Promise((r) => setTimeout(r, 50));

    // Verify message was edited/locked on Telegram
    expect(provider.editedMessages.length).toBe(1);
    expect(provider.editedMessages[0].text).toContain('✅ *Answered* (via text): Use /api/v2/metrics');
    expect(provider.editedMessages[0].options?.actions?.flat().some((b) => b.payload.startsWith('v1:inf'))).toBe(false);

    // Verify GitHub comment posted
    expect(mockGh.addComment).toHaveBeenCalledWith(
      42,
      expect.stringContaining('💬 **Developer Response** (via Telegram):\n\nUse /api/v2/metrics')
    );

    // Verify runner execution unblocked
    expect(mockRunnerFacade.run).toHaveBeenCalledTimes(1);
    const runnerContext = mockRunnerFacade.run.mock.calls[0][0];
    expect(runnerContext.userFeedback).toBe('Use /api/v2/metrics');
  });
});
