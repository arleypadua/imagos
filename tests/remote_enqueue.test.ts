import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RemoteControlManager } from '../src/remote/manager.js';
import type {
  RemoteControlProvider,
  RemoteMessageOptions,
  RemoteActionController,
  ActionContext,
} from '../src/remote/types.js';
import type { EnqueueResult } from '../src/types/index.js';
import { Notifier } from '../src/notifications/notifier.js';
import { AgentEventBus } from '../src/events/bus.js';

class MockRemoteProvider implements RemoteControlProvider {
  public readonly name = 'mock';
  public isStarted = false;
  public sentMessages: Array<{ text: string; options?: RemoteMessageOptions }> = [];
  public editedMessages: Array<{ messageId: number; text: string; options?: RemoteMessageOptions }> = [];
  public actionHandlers: Map<
    string,
    (action: string, payload: string, userId: number, context?: ActionContext) => Promise<void>
  > = new Map();
  public commandHandlers: Map<
    string,
    (args: string[], userId: number, context?: ActionContext) => Promise<void>
  > = new Map();
  public allowedUserIds?: number[] = [123456];

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

  public onCommand(
    command: string,
    handler: (args: string[], userId: number, context?: ActionContext) => Promise<void>
  ): void {
    this.commandHandlers.set(command, handler);
  }

  public getAllowedUserIds(): number[] | undefined {
    return this.allowedUserIds;
  }

  public async triggerCommand(
    command: string,
    args: string[],
    userId: number = 123456,
    context?: ActionContext
  ): Promise<void> {
    const handler = this.commandHandlers.get(command);
    if (handler) {
      await handler(args, userId, context);
    }
  }

  public async triggerAction(
    payload: string,
    userId: number = 123456,
    context?: ActionContext
  ): Promise<void> {
    for (const [prefix, handler] of this.actionHandlers.entries()) {
      if (payload.startsWith(prefix)) {
        await handler(prefix, payload, userId, context);
        break;
      }
    }
  }
}

describe('Remote Control Enqueue Command & Callbacks', () => {
  let provider: MockRemoteProvider;
  let manager: RemoteControlManager;
  let mockController: RemoteActionController & {
    lastEnqueuedIssue?: number;
    lastEnqueueOptions?: { force?: boolean };
  };

  beforeEach(() => {
    Notifier.removeAllListeners();
    AgentEventBus.getInstance().clearHistory();

    provider = new MockRemoteProvider();
    mockController = {
      replyToNeedsInfo: vi.fn().mockResolvedValue(undefined),
      resumeQuota: vi.fn(),
      pauseTask: vi.fn().mockResolvedValue({ success: true, message: 'Paused' }),
      resumeTask: vi.fn().mockResolvedValue({ success: true, message: 'Resumed' }),
      setTargetSpecs: vi.fn(),
      getStatusSummary: vi.fn().mockReturnValue({}),
      enqueueTask: vi.fn().mockImplementation(async (issueNum: number, options?: { force?: boolean }): Promise<EnqueueResult> => {
        mockController.lastEnqueuedIssue = issueNum;
        mockController.lastEnqueueOptions = options;

        if (issueNum === 88 && !options?.force) {
          return {
            success: false,
            message: 'Issue #88 is blocked by #80 (open). Pass --force to enqueue anyway.',
            requiresConfirmation: true,
            blockerNumbers: [80],
          };
        }

        return {
          success: true,
          message: `Enqueued Issue #${issueNum} into priority queue.`,
        };
      }),
    };

    manager = new RemoteControlManager({
      provider,
      repository: 'owner/repo',
      defaultChatId: 9999,
      actionController: mockController,
    });
  });

  afterEach(() => {
    Notifier.removeAllListeners();
    vi.restoreAllMocks();
  });

  it('handles /enqueue <issueNumber> command when unblocked', async () => {
    await provider.triggerCommand('enqueue', ['42']);

    expect(mockController.enqueueTask).toHaveBeenCalledWith(42, expect.objectContaining({ force: false }));
    expect(provider.sentMessages.length).toBe(1);
    expect(provider.sentMessages[0].text).toContain('Priority Enqueued');
    expect(provider.sentMessages[0].text).toContain('#42');
  });

  it('handles /run alias identically to /enqueue', async () => {
    await provider.triggerCommand('run', ['55']);

    expect(mockController.enqueueTask).toHaveBeenCalledWith(55, expect.objectContaining({ force: false }));
    expect(provider.sentMessages.length).toBe(1);
    expect(provider.sentMessages[0].text).toContain('Priority Enqueued');
    expect(provider.sentMessages[0].text).toContain('#55');
  });

  it('prompts with inline buttons when blocked issue requires confirmation', async () => {
    await provider.triggerCommand('enqueue', ['88']);

    expect(mockController.enqueueTask).toHaveBeenCalledWith(88, expect.objectContaining({ force: false }));
    expect(provider.sentMessages.length).toBe(1);
    expect(provider.sentMessages[0].text).toContain('Confirmation Required');
    expect(provider.sentMessages[0].options?.actions).toBeDefined();

    const actions = provider.sentMessages[0].options!.actions!;
    expect(actions[0][0].label).toContain('Force Enqueue');
    expect(actions[0][0].payload).toBe('v1:enq:88:f');
    expect(actions[0][1].label).toContain('Cancel');
    expect(actions[0][1].payload).toBe('v1:enq:88:c');
  });

  it('bypasses confirmation when --force is passed to /enqueue', async () => {
    await provider.triggerCommand('enqueue', ['88', '--force']);

    expect(mockController.enqueueTask).toHaveBeenCalledWith(88, expect.objectContaining({ force: true }));
    expect(provider.sentMessages.length).toBe(1);
    expect(provider.sentMessages[0].text).toContain('Priority Enqueued');
    expect(provider.sentMessages[0].options?.actions).toBeUndefined();
  });

  it('executes force enqueue on callback button press (v1:enq:88:f)', async () => {
    const context: ActionContext = { messageId: 101, chatId: 9999 };
    await provider.triggerAction('v1:enq:88:f', 123456, context);

    expect(mockController.enqueueTask).toHaveBeenCalledWith(88, expect.objectContaining({ force: true }));
    expect(provider.editedMessages.length).toBe(1);
    expect(provider.editedMessages[0].messageId).toBe(101);
    expect(provider.editedMessages[0].text).toContain('Priority Enqueued');
  });

  it('cancels enqueue on cancel callback button press (v1:enq:88:c)', async () => {
    const context: ActionContext = { messageId: 102, chatId: 9999 };
    await provider.triggerAction('v1:enq:88:c', 123456, context);

    expect(mockController.enqueueTask).not.toHaveBeenCalledWith(88, expect.objectContaining({ force: true }));
    expect(provider.editedMessages.length).toBe(1);
    expect(provider.editedMessages[0].messageId).toBe(102);
    expect(provider.editedMessages[0].text).toContain('cancelled by developer');
  });

  it('shows usage information when /enqueue is sent without arguments', async () => {
    await provider.triggerCommand('enqueue', []);

    expect(mockController.enqueueTask).not.toHaveBeenCalled();
    expect(provider.sentMessages.length).toBe(1);
    expect(provider.sentMessages[0].text).toContain('Usage');
  });
});
