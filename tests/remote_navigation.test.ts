import { describe, it, expect, beforeEach } from 'vitest';
import { RemoteControlManager } from '../src/remote/manager.js';
import { AgentEventBus } from '../src/events/bus.js';
import {
  buildNavCallbackData,
  parseNavCallbackData,
  buildActionCallbackData,
  parseActionCallbackData,
  parseLimitCallbackData,
  parseLimitArgs,
} from '../src/remote/navigation.js';
import type {
  ActionContext,
  InteractiveAction,
  QuotaLimitsSummary,
  RemoteActionController,
  RemoteControlProvider,
  RemoteMessageOptions,
} from '../src/remote/types.js';

type Handler = (action: string, payload: string, userId: number, context?: ActionContext) => Promise<void>;

class FakeProvider implements RemoteControlProvider {
  public readonly name = 'fake';
  public sent: Array<{ text: string; options?: RemoteMessageOptions }> = [];
  public edited: Array<{ messageId: number; text: string; options?: RemoteMessageOptions }> = [];
  private actions = new Map<string, Handler>();
  private commands = new Map<string, (args: string[], userId: number, context?: ActionContext) => Promise<void>>();
  private replies: Array<(replyTo: number, text: string, userId: number) => Promise<void>> = [];

  async start() {}
  async stop() {}
  async sendMessage(text: string, options?: RemoteMessageOptions) {
    this.sent.push({ text, options });
    return { messageId: 100 + this.sent.length };
  }
  async editMessage(messageId: number, text: string, options?: RemoteMessageOptions) {
    this.edited.push({ messageId, text, options });
  }
  onAction(prefix: string, handler: Handler) {
    this.actions.set(prefix, handler);
  }
  onCommand(command: string, handler: (args: string[], userId: number, context?: ActionContext) => Promise<void>) {
    this.commands.set(command, handler);
  }
  onTextReply(handler: (replyTo: number, text: string, userId: number) => Promise<void>) {
    this.replies.push(handler);
  }
  async tap(payload: string, messageId = 7) {
    for (const [prefix, handler] of this.actions) {
      if (payload.startsWith(prefix)) {
        await handler(prefix, payload, 1, { messageId, chatId: 9 });
        return;
      }
    }
    throw new Error(`no handler for ${payload}`);
  }
  async command(name: string, args: string[] = []) {
    await this.commands.get(name)!(args, 1, { chatId: 9 });
  }
  async reply(replyTo: number, text: string) {
    for (const r of this.replies) await r(replyTo, text, 1);
  }
}

const payloads = (actions?: InteractiveAction[][]) => (actions ?? []).flat().map((b) => b.payload);
const urls = (actions?: InteractiveAction[][]) => (actions ?? []).flat().map((b) => b.url).filter(Boolean);

function makeController() {
  const calls: { limits: Array<{ fiveHourPercent?: number; weeklyPercent?: number }>; steered: Array<[number, string]>; paused: number[] } = {
    limits: [],
    steered: [],
    paused: [],
  };
  let limits: QuotaLimitsSummary = {
    fiveHourPercent: 85,
    weeklyPercent: 90,
    pauseOnLimit: true,
    windows: [{ runnerName: 'claude', name: 'Weekly', windowType: 'weekly', usedPercentage: 40, limitPercent: 90, resetText: 'Nov 9' }],
    pausedRunners: [],
  };
  const controller: RemoteActionController = {
    replyToNeedsInfo: async () => {},
    resumeQuota: () => {},
    pauseTask: async (n) => {
      calls.paused.push(n);
      return { success: true, message: `Paused #${n}` };
    },
    resumeTask: async () => ({ success: true, message: 'ok' }),
    setTargetSpecs: () => {},
    getStatusSummary: () => ({ daemonStatus: 'running', activeWorkers: [], maxConcurrency: 2, quota: { isPaused: false } }),
    getTasksSummary: () => ({
      inProgress: [{ issueNumber: 42, title: 'feat: running thing', status: 'running' }],
      paused: [],
      queued: [{ issueNumber: 43, title: 'feat: queued thing', status: 'ready' }],
    }),
    getInspectSummary: async (n) => `*Issue #${n}*\n• Status: \`running\``,
    getLogsSummary: async (n) => `log line for ${n}`,
    getIssueState: (n) => (n === 42 ? 'running' : 'queued'),
    getIssueLinks: async (n) => ({
      issueUrl: `https://github.com/o/issues/issues/${n}`,
      prUrl: n === 42 ? 'https://github.com/o/code/pull/7' : undefined,
      prNumber: n === 42 ? 7 : undefined,
    }),
    injectPrompt: async (n, prompt) => {
      calls.steered.push([n, prompt]);
      return { success: true, message: 'injected' };
    },
    getQuotaLimits: () => limits,
    updateQuotaLimits: async (change) => {
      calls.limits.push(change);
      limits = {
        ...limits,
        fiveHourPercent: change.fiveHourPercent ?? limits.fiveHourPercent,
        weeklyPercent: change.weeklyPercent ?? limits.weeklyPercent,
      };
      return { success: true, message: 'Limits updated.', limits };
    },
  };
  return { controller, calls };
}

describe('navigation callback data', () => {
  it('round-trips views and actions within Telegram\'s 64-byte limit', () => {
    for (const target of [
      { view: 'menu' as const },
      { view: 'inspect' as const },
      { view: 'inspect' as const, issueNumber: 123456 },
      { view: 'logs' as const, issueNumber: 9 },
      { view: 'browse' as const, page: 3 },
    ]) {
      const data = buildNavCallbackData(target);
      expect(data.length).toBeLessThanOrEqual(64);
      expect(parseNavCallbackData(data)).toEqual(target);
    }
    expect(parseActionCallbackData(buildActionCallbackData({ action: 'steer', issueNumber: 42 }))).toEqual({
      action: 'steer',
      issueNumber: 42,
    });
    expect(parseActionCallbackData('v1:a:clean')).toEqual({ action: 'clean' });
    expect(parseActionCallbackData('v1:a:pause:x')).toBeNull();
    expect(parseLimitCallbackData('v1:l:w:95')).toEqual({ window: 'w', percent: 95 });
    expect(parseLimitCallbackData('v1:l:w:0')).toBeNull();
  });

  it('parses /limits arguments in the forms people type', () => {
    expect(parseLimitArgs(['weekly', '90'])).toEqual({ weeklyPercent: 90 });
    expect(parseLimitArgs(['5h', '80%', 'w', '95'])).toEqual({ fiveHourPercent: 80, weeklyPercent: 95 });
    expect(parseLimitArgs(['weekly=0.85'])).toEqual({ weeklyPercent: 85 });
    expect(parseLimitArgs(['weekly', '120']).error).toBeDefined();
    expect(parseLimitArgs(['daily', '50']).error).toBeDefined();
  });
});

describe('RemoteControlManager navigation', () => {
  let provider: FakeProvider;
  let calls: ReturnType<typeof makeController>['calls'];

  beforeEach(() => {
    provider = new FakeProvider();
    const made = makeController();
    calls = made.calls;
    new RemoteControlManager({
      provider,
      repository: 'o/code',
      issueRepository: 'o/issues',
      defaultChatId: 9,
      eventBus: new AgentEventBus(),
      actionController: made.controller,
    });
  });

  it('/menu offers a button into every view', async () => {
    await provider.command('menu');
    const p = payloads(provider.sent[0].options?.actions);
    for (const view of ['status', 'tasks', 'browse:1', 'specs', 'inspect', 'logs', 'steer', 'limits']) {
      expect(p).toContain(`v1:n:${view}`);
    }
  });

  it('/inspect without an issue lists the tasks as buttons, not only copyable commands', async () => {
    await provider.command('inspect');
    const p = payloads(provider.sent[0].options?.actions);
    expect(p).toContain('v1:n:inspect:42');
    expect(p).toContain('v1:n:inspect:43');
  });

  it('tapping an issue opens its inspect view in place with controls and issue/PR links', async () => {
    await provider.command('inspect'); // the picker view, message 101
    await provider.tap('v1:n:inspect:42', 101);

    expect(provider.sent).toHaveLength(1);
    expect(provider.edited).toHaveLength(1);
    const view = provider.edited[0];
    expect(view.messageId).toBe(101);
    expect(view.text).toContain('Inspection: Issue #42');
    const p = payloads(view.options?.actions);
    expect(p).toEqual(expect.arrayContaining(['v1:n:logs:42', 'v1:a:steer:42', 'v1:a:pause:42', 'v1:n:inspect', 'v1:n:menu']));
    expect(urls(view.options?.actions)).toEqual(['https://github.com/o/issues/issues/42', 'https://github.com/o/code/pull/7']);
  });

  it('a button on a notification opens a new view and leaves the notification alone', async () => {
    await provider.tap('v1:n:inspect:43', 55);
    expect(provider.edited).toHaveLength(0);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].text).toContain('Inspection: Issue #43');
  });

  it('offers to run a queued issue from its inspect view', async () => {
    await provider.command('inspect', ['43']);
    expect(payloads(provider.sent[0].options?.actions)).toContain('v1:a:now:43');
  });

  it('pausing from the inspect view re-renders it with a notice', async () => {
    await provider.command('inspect', ['42']);
    await provider.tap('v1:a:pause:42', 101);
    expect(calls.paused).toEqual([42]);
    expect(provider.edited[0].text).toContain('Paused worker for Issue #42');
    expect(provider.edited[0].text).toContain('Inspection: Issue #42');
  });

  it('the steer button asks for instructions and the reply steers the issue', async () => {
    await provider.tap('v1:a:steer:42');
    const prompt = provider.sent[0];
    expect(prompt.options?.forceReply).toBeDefined();
    expect(prompt.text).toContain('Steer #42');

    await provider.reply(101, 'focus on the tests');
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.steered).toEqual([[42, 'focus on the tests']]);
  });

  it('/limits shows both limits with buttons to adjust them', async () => {
    await provider.command('limits');
    const msg = provider.sent[0];
    expect(msg.text).toContain('*5h session limit*: 85%');
    expect(msg.text).toContain('*Weekly limit*: 90%');
    expect(payloads(msg.options?.actions)).toEqual(expect.arrayContaining(['v1:l:h:80', 'v1:l:h:90', 'v1:l:w:85', 'v1:l:w:95']));
  });

  it('/limits weekly 80 changes the weekly limit', async () => {
    await provider.command('limits', ['weekly', '80']);
    expect(calls.limits).toEqual([{ weeklyPercent: 80 }]);
    expect(provider.sent[0].text).toContain('*Weekly limit*: 80%');
  });

  it('a limit button changes the limit and updates the view in place', async () => {
    await provider.command('limits');
    await provider.tap('v1:l:w:95', 101);
    expect(calls.limits).toEqual([{ weeklyPercent: 95 }]);
    expect(provider.edited[0].text).toContain('*Weekly limit*: 95%');
    expect(payloads(provider.edited[0].options?.actions)).toContain('v1:l:w:100');
  });

  it('task started notifications carry follow-ups and links to the issue repository', async () => {
    const manager = new RemoteControlManager({
      provider,
      repository: 'o/code',
      issueRepository: 'o/issues',
      defaultChatId: 9,
      eventBus: new AgentEventBus(),
    });
    await manager.sendTaskStarted({ issueNumber: 5, issueTitle: 't', runnerName: 'claude', branchName: 'b' });
    const actions = provider.sent[0].options?.actions;
    expect(payloads(actions)).toEqual(expect.arrayContaining(['v1:n:inspect:5', 'v1:n:logs:5', 'v1:a:steer:5']));
    expect(urls(actions)).toEqual(['https://github.com/o/issues/issues/5']);
  });
});
