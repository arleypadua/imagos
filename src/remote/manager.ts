import type {
  RemoteControlProvider,
  RemoteActionController,
  BrowseIssueSummary,
  RemoteControlManagerOptions,
  RemoteMessageOptions,
  InteractiveAction,
  ActionContext,
  ActiveNeedsInfoRecord,
  TaskStartedNotificationPayload,
  TaskCompletedNotificationPayload,
  SpecCompletedNotificationPayload,
  NeedsInfoNotificationPayload,
  QuotaPausedNotificationPayload,
  QuotaResumedNotificationPayload,
  TasksSummary,
  SpecsSummary,
  SecurityStatusInfo,
  IssueLinks,
  IssueRunState,
} from './types.js';
import type { TelegramNotificationsConfig } from '../types/index.js';
import { AgentEventBus, type AgentEvent } from '../events/bus.js';
import { Notifier } from '../notifications/notifier.js';
import { ActivityLogger } from '../logger/index.js';
import {
  formatTaskStarted,
  formatTaskCompleted,
  formatSpecCompleted,
  formatNeedsInfo,
  formatNeedsInfoAnswered,
  formatQuotaPaused,
  formatQuotaResumed,
  formatQuotaResumedByDeveloper,
  buildQuotaResumeCallbackData,
  parseQuotaActionPayload,
  parseQuestionChoices,
  formatStatus,
  formatTasks,
  formatSpecs,
  formatHelp,
  formatDispatchPaused,
  formatDispatchResumed,
  formatSpecsUpdated,
  formatTaskActionResponse,
  parseTaskActionPayload,
  parseSpecActionPayload,
  formatCleanResult,
  formatInspect,
  formatInspectHelp,
  formatLogs,
  formatLogsHelp,
  formatEnqueueConfirmation,
  formatEnqueueResult,
  parseEnqueueActionPayload,
  formatRepoTag,
  formatSteeringFeedback,
  formatSteeringLiveTailReport,
  formatSteerUsage,
  formatEnqueueUsage,
  formatPauseUsage,
  formatResumeUsage,
  formatBrowse,
  parseBrowseActionPayload,
  formatMenu,
  formatLimits,
  formatSteerPrompt,
  escapeMarkdown,
} from './formatters.js';
import {
  NAV_PREFIX,
  ACTION_PREFIX,
  LIMIT_PREFIX,
  parseNavCallbackData,
  parseActionCallbackData,
  parseLimitCallbackData,
  parseLimitArgs,
  buildLinkRow,
  buildFooterRow,
  buildMainMenuRows,
  buildIssuePickerRows,
  buildIssueControlRows,
  buildLimitAdjustRows,
  navButton,
  actionButton,
  urlButton,
  type NavTarget,
  type PickerItem,
} from './navigation.js';
import { parseEnqueueArgs, ENQUEUE_USAGE } from '../pipeline/enqueue_help.js';
import type { QuotaMonitor } from '../quota/monitor.js';

/** Telegram rejects messages over 4096 characters; leave room for the notice line a view may carry. */
const MAX_MESSAGE_CHARS = 3900;
const LOGS_TAIL_LINES = 60;
const MAX_TRACKED_VIEWS = 500;

interface View {
  text: string;
  actions: InteractiveAction[][];
}

function clampText(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  const cut = text.slice(0, MAX_MESSAGE_CHARS);
  // An unterminated code block would break Markdown for the whole message.
  const fences = (cut.match(/```/g) || []).length;
  return `${cut}${fences % 2 === 1 ? '\n```' : ''}\n…`;
}

export interface SendQuotaPausedOptions extends RemoteMessageOptions {
  actions?: InteractiveAction[][];
}

export class RemoteControlManager {
  private provider: RemoteControlProvider;
  private repository?: string;
  private issueRepository?: string;
  private defaultChatId?: number | string;
  private notifications: TelegramNotificationsConfig & { taskStarted?: boolean };
  private eventBus: AgentEventBus;
  private actionController?: RemoteActionController;
  private quotaMonitor?: QuotaMonitor;
  private isStarted: boolean = false;

  private processedQuotaActions = new Set<string>();
  private lastPausedEvent?: { resetAt: number; runner?: string; timestamp: number };
  private lastResumedEvent?: { runner?: string; timestamp: number };
  private messageNeedsInfo: Map<number, ActiveNeedsInfoRecord> = new Map();
  private issueNeedsInfo: Map<number, ActiveNeedsInfoRecord> = new Map();
  private taskMessageMap: Map<number, number> = new Map();
  /** Messages that show a view, which navigation may replace; notifications are never in here. */
  private viewMessageIds: Set<number> = new Set();

  private boundOnTaskStarted: (payload: TaskStartedNotificationPayload) => void;
  private boundOnTaskCompleted: (payload: TaskCompletedNotificationPayload) => void;
  private boundOnSpecCompleted: (payload: SpecCompletedNotificationPayload) => void;
  private boundOnNeedsInfo: (payload: NeedsInfoNotificationPayload) => void;
  private boundOnQuotaPaused: (payload: QuotaPausedNotificationPayload) => void;
  private boundOnQuotaResumed: (payload: QuotaResumedNotificationPayload) => void;
  private boundOnQuotaMonitorPaused?: (event: any) => void;
  private boundOnQuotaMonitorResumed?: (event: any) => void;
  private boundOnAgentEvent: (event: AgentEvent) => void;

  constructor(options: RemoteControlManagerOptions) {
    this.provider = options.provider;
    this.repository = options.repository;
    this.issueRepository = options.issueRepository;
    this.defaultChatId = options.defaultChatId;
    this.notifications = {
      needsInfo: options.notifications?.needsInfo ?? true,
      quotaPaused: options.notifications?.quotaPaused ?? true,
      taskCompleted: options.notifications?.taskCompleted ?? true,
      specCompleted: options.notifications?.specCompleted ?? true,
      taskStarted: (options.notifications as any)?.taskStarted ?? true,
      ...options.notifications,
    };
    this.eventBus = options.eventBus ?? AgentEventBus.getInstance();
    this.actionController = options.actionController;
    this.quotaMonitor = options.quotaMonitor;

    this.boundOnTaskStarted = (payload) => {
      this.handleTaskStarted(payload).catch((err) => {
        ActivityLogger.error('RemoteControlManager error handling task_started:', err);
      });
    };
    this.boundOnTaskCompleted = (payload) => {
      this.handleTaskCompleted(payload).catch((err) => {
        ActivityLogger.error('RemoteControlManager error handling task_completed:', err);
      });
    };
    this.boundOnSpecCompleted = (payload) => {
      this.handleSpecCompleted(payload).catch((err) => {
        ActivityLogger.error('RemoteControlManager error handling spec_completed:', err);
      });
    };
    this.boundOnNeedsInfo = (payload) => {
      this.handleNeedsInfo(payload).catch((err) => {
        ActivityLogger.error('RemoteControlManager error handling needs_info:', err);
      });
    };
    this.boundOnQuotaPaused = (payload) => {
      this.handleQuotaPaused(payload).catch((err) => {
        ActivityLogger.error('RemoteControlManager error handling quota_paused:', err);
      });
    };
    this.boundOnQuotaResumed = (payload) => {
      this.handleQuotaResumed(payload).catch((err) => {
        ActivityLogger.error('RemoteControlManager error handling quota_resumed:', err);
      });
    };
    if (this.quotaMonitor) {
      this.boundOnQuotaMonitorPaused = ({ resetAt, waitMs, runnerName, affectedIssues, reason }: any) => {
        const waitMinutes = Math.ceil(
          (waitMs ?? (resetAt ? Math.max(1000, new Date(resetAt).getTime() - Date.now()) : 60000)) /
            (60 * 1000)
        );
        this.handleQuotaPaused({ resetAt: new Date(resetAt), waitMinutes, runnerName, affectedIssues, reason }).catch((err) => {
          ActivityLogger.error('RemoteControlManager error handling quota_monitor paused:', err);
        });
      };
      this.boundOnQuotaMonitorResumed = ({ runnerName }: any) => {
        this.handleQuotaResumed({ runnerName }).catch((err) => {
          ActivityLogger.error('RemoteControlManager error handling quota_monitor resumed:', err);
        });
      };
    }
    this.boundOnAgentEvent = (event) => {
      this.handleAgentEvent(event);
    };

    this.setupProviderListeners();
  }

  private setupProviderListeners(): void {
    // Register quota action handler with provider
    this.provider.onAction('v1:q', async (_action, payload, userId, context) => {
      await this.handleQuotaAction(payload, userId, context);
    });

    // Register needs-info action handler with provider
    this.provider.onAction('v1:inf', async (_action, payload, userId) => {
      await this.handleNeedsInfoAction(payload, userId);
    });

    // Register task action handler with provider (pause / resume individual worker)
    this.provider.onAction('v1:t', async (_action, payload, userId, context) => {
      await this.handleTaskAction(payload, userId, context);
    });

    // Register spec target action handler with provider
    this.provider.onAction('v1:s', async (_action, payload, userId, context) => {
      await this.handleSpecAction(payload, userId, context);
    });

    // Register enqueue action handler with provider
    this.provider.onAction('v1:enq', async (_action, payload, userId, context) => {
      await this.handleEnqueueAction(payload, userId, context);
    });

    this.provider.onAction('v1:b', async (_action, payload, userId, context) => {
      await this.handleBrowseAction(payload, userId, context);
    });

    this.provider.onAction(NAV_PREFIX, async (_action, payload, userId, context) => {
      await this.handleNavAction(payload, userId, context);
    });

    this.provider.onAction(ACTION_PREFIX, async (_action, payload, userId, context) => {
      await this.handleIssueOrDaemonAction(payload, userId, context);
    });

    this.provider.onAction(LIMIT_PREFIX, async (_action, payload, userId, context) => {
      await this.handleLimitAction(payload, userId, context);
    });

    if (this.provider.onTextReply) {
      this.provider.onTextReply(async (replyToMessageId, text, userId) => {
        await this.handleTextReply(replyToMessageId, text, userId);
      });
    }

    if (this.provider.onCommand) {
      this.provider.onCommand('start', async (args, userId, context) => {
        await this.handleHelpCommand(args, userId, context);
      });
      this.provider.onCommand('status', async (args, userId, context) => {
        await this.handleStatusCommand(args, userId, context);
      });
      this.provider.onCommand('tasks', async (args, userId, context) => {
        await this.handleTasksCommand(args, userId, context);
      });
      this.provider.onCommand('browse', async (args, userId, context) => {
        await this.handleBrowseCommand(args, userId, context);
      });
      this.provider.onCommand('browse-issues', async (args, userId, context) => {
        await this.handleBrowseCommand(args, userId, context);
      });
      this.provider.onCommand('issues', async (args, userId, context) => {
        await this.handleBrowseCommand(args, userId, context);
      });
      this.provider.onCommand('tree', async (args, userId, context) => {
        await this.handleBrowseCommand(args, userId, context);
      });
      this.provider.onCommand('steer', async (args, userId, context) => {
        await this.handleSteerCommand(args, userId, context);
      });
      this.provider.onCommand('prompt', async (args, userId, context) => {
        await this.handleSteerCommand(args, userId, context);
      });
      this.provider.onCommand('enqueue', async (args, userId, context) => {
        await this.handleEnqueueCommand(args, userId, context);
      });
      this.provider.onCommand('run', async (args, userId, context) => {
        await this.handleEnqueueCommand(args, userId, context);
      });
      this.provider.onCommand('pause', async (args, userId, context) => {
        await this.handlePauseCommand(args, userId, context);
      });
      this.provider.onCommand('resume', async (args, userId, context) => {
        await this.handleResumeCommand(args, userId, context);
      });
      this.provider.onCommand('specs', async (args, userId, context) => {
        await this.handleSpecsCommand(args, userId, context);
      });
      this.provider.onCommand('clean', async (args, userId, context) => {
        await this.handleCleanCommand(args, userId, context);
      });
      this.provider.onCommand('inspect', async (args, userId, context) => {
        await this.handleInspectCommand(args, userId, context);
      });
      this.provider.onCommand('logs', async (args, userId, context) => {
        await this.handleLogsCommand(args, userId, context);
      });
      this.provider.onCommand('help', async (args, userId, context) => {
        await this.handleHelpCommand(args, userId, context);
      });
      this.provider.onCommand('menu', async (args, userId, context) => {
        await this.handleMenuCommand(args, userId, context);
      });
      this.provider.onCommand('limits', async (args, userId, context) => {
        await this.handleLimitsCommand(args, userId, context);
      });
      this.provider.onCommand('settings', async (args, userId, context) => {
        await this.handleLimitsCommand(args, userId, context);
      });
    }
  }

  public getProvider(): RemoteControlProvider {
    return this.provider;
  }

  public getRepository(): string | undefined {
    return this.repository;
  }

  public getDefaultChatId(): number | string | undefined {
    return this.defaultChatId;
  }

  public getNotificationsConfig(): TelegramNotificationsConfig {
    return { ...this.notifications };
  }

  public setActionController(controller: RemoteActionController): void {
    this.actionController = controller;
  }

  public getActionController(): RemoteActionController | undefined {
    return this.actionController;
  }

  public isRunning(): boolean {
    return this.isStarted;
  }

  public getActiveNeedsInfo(issueNumber: number): ActiveNeedsInfoRecord | undefined {
    return this.issueNeedsInfo.get(issueNumber);
  }

  public getActiveNeedsInfoByMessageId(messageId: number): ActiveNeedsInfoRecord | undefined {
    return this.messageNeedsInfo.get(messageId);
  }

  public async start(): Promise<void> {
    if (this.isStarted) return;
    this.isStarted = true;

    Notifier.on('task_started', this.boundOnTaskStarted);
    Notifier.on('task_completed', this.boundOnTaskCompleted);
    Notifier.on('spec_completed', this.boundOnSpecCompleted);
    Notifier.on('needs_info', this.boundOnNeedsInfo);
    Notifier.on('quota_paused', this.boundOnQuotaPaused);
    Notifier.on('quota_resumed', this.boundOnQuotaResumed);

    if (this.quotaMonitor && this.boundOnQuotaMonitorPaused && this.boundOnQuotaMonitorResumed) {
      this.quotaMonitor.on('quota_paused', this.boundOnQuotaMonitorPaused);
      this.quotaMonitor.on('quota_resumed', this.boundOnQuotaMonitorResumed);
    }

    this.eventBus.on('agent_event', this.boundOnAgentEvent);

    await this.provider.start();
  }

  public async stop(): Promise<void> {
    if (!this.isStarted) return;
    this.isStarted = false;

    Notifier.off('task_started', this.boundOnTaskStarted);
    Notifier.off('task_completed', this.boundOnTaskCompleted);
    Notifier.off('spec_completed', this.boundOnSpecCompleted);
    Notifier.off('needs_info', this.boundOnNeedsInfo);
    Notifier.off('quota_paused', this.boundOnQuotaPaused);
    Notifier.off('quota_resumed', this.boundOnQuotaResumed);

    if (this.quotaMonitor && this.boundOnQuotaMonitorPaused && this.boundOnQuotaMonitorResumed) {
      this.quotaMonitor.off('quota_paused', this.boundOnQuotaMonitorPaused);
      this.quotaMonitor.off('quota_resumed', this.boundOnQuotaMonitorResumed);
    }

    this.eventBus.off('agent_event', this.boundOnAgentEvent);

    await this.provider.stop();
  }

  public async sendTaskStarted(
    payload: TaskStartedNotificationPayload,
    chatId?: number | string
  ): Promise<{ messageId: number } | undefined> {
    if (this.notifications.taskStarted === false) {
      return undefined;
    }
    const text = formatTaskStarted(this.repository, payload);
    const links = await this.getLinks(payload.issueNumber);
    const msg = await this.provider.sendMessage(text, {
      chatId: chatId ?? this.defaultChatId,
      parseMode: 'Markdown',
      actions: [
        ...buildIssueControlRows(payload.issueNumber, 'running', 'other'),
        buildLinkRow(payload.issueNumber, links),
      ].filter((r) => r.length > 0),
    });
    if (msg?.messageId) {
      this.taskMessageMap.set(msg.messageId, payload.issueNumber);
    }
    return msg;
  }

  public async sendTaskCompleted(
    payload: TaskCompletedNotificationPayload,
    chatId?: number | string
  ): Promise<{ messageId: number } | undefined> {
    if (!this.notifications.taskCompleted) {
      return undefined;
    }
    const text = formatTaskCompleted(this.repository, payload);
    const links = await this.getLinks(payload.issueNumber, { prUrl: payload.prUrl, prNumber: payload.prNumber });
    return this.provider.sendMessage(text, {
      chatId: chatId ?? this.defaultChatId,
      parseMode: 'Markdown',
      actions: [
        buildLinkRow(payload.issueNumber, links),
        [navButton('📋 Tasks', { view: 'tasks' }), navButton('🏠 Menu', { view: 'menu' })],
      ].filter((r) => r.length > 0),
    });
  }

  public async sendSpecCompleted(
    payload: SpecCompletedNotificationPayload,
    chatId?: number | string
  ): Promise<{ messageId: number } | undefined> {
    if (!this.notifications.specCompleted) {
      return undefined;
    }
    const text = formatSpecCompleted(this.repository, payload);
    const specUrl = this.issueUrlFor(payload.specNumber);
    return this.provider.sendMessage(text, {
      chatId: chatId ?? this.defaultChatId,
      parseMode: 'Markdown',
      actions: [
        specUrl ? [urlButton(`🔗 Spec #${payload.specNumber}`, specUrl)] : [],
        [navButton('🎯 Specs', { view: 'specs' }), navButton('🏠 Menu', { view: 'menu' })],
      ].filter((r) => r.length > 0),
    });
  }

  public async sendNeedsInfo(
    payload: NeedsInfoNotificationPayload,
    options?: RemoteMessageOptions
  ): Promise<{ messageId: number } | undefined> {
    if (!this.notifications.needsInfo) {
      return undefined;
    }
    const text = formatNeedsInfo(this.repository, payload);
    const targetChatId = options?.chatId ?? this.defaultChatId;

    let actions = options?.actions;
    const choices = payload.choices && payload.choices.length > 0
      ? payload.choices
      : parseQuestionChoices(payload.question);

    if (!actions) {
      const generatedActions: InteractiveAction[][] = [];
      if (choices.length > 0) {
        for (let i = 0; i < choices.length; i++) {
          const choice = choices[i];
          const cleanLabel = choice.replace(/^[\d+a-zA-Z][\.\)]\s*/, '').replace(/[*_`]/g, '').trim();
          const buttonLabel = cleanLabel.length > 35 ? cleanLabel.slice(0, 32) + '...' : cleanLabel;
          generatedActions.push([
            {
              id: `inf_${payload.issueNumber}_${i}`,
              label: buttonLabel,
              payload: `v1:inf:${payload.issueNumber}:${i}`,
            },
          ]);
        }
      }

      const links = await this.getLinks(payload.issueNumber, {
        issueUrl: payload.issueUrl,
        prUrl: payload.prUrl,
        prNumber: payload.prNumber,
      });
      generatedActions.push(...this.needsInfoFollowUpRows(payload.issueNumber, links));

      if (generatedActions.length > 0) {
        actions = generatedActions;
      }
    }

    const res = await this.provider.sendMessage(text, {
      chatId: targetChatId,
      parseMode: options?.parseMode ?? 'Markdown',
      actions,
      replyToMessageId: options?.replyToMessageId,
    });

    const record: ActiveNeedsInfoRecord = {
      issueNumber: payload.issueNumber,
      messageId: res.messageId,
      chatId: targetChatId,
      payload,
      choices,
      originalText: text,
      answered: false,
      createdAt: Date.now(),
    };

    this.messageNeedsInfo.set(res.messageId, record);
    this.issueNeedsInfo.set(payload.issueNumber, record);

    return res;
  }

  public async handleNeedsInfoAction(payload: string, userId: number): Promise<void> {
    const parts = payload.split(':');
    if (parts.length < 4) {
      return;
    }
    const issueNumber = parseInt(parts[2], 10);
    const choiceKey = parts.slice(3).join(':');

    if (isNaN(issueNumber)) {
      return;
    }

    const activeInfo = this.issueNeedsInfo.get(issueNumber);
    if (activeInfo && activeInfo.answered) {
      return; // Already answered
    }

    let answerText = choiceKey;
    const choiceIndex = parseInt(choiceKey, 10);
    if (!isNaN(choiceIndex) && activeInfo && activeInfo.choices && activeInfo.choices[choiceIndex] !== undefined) {
      answerText = activeInfo.choices[choiceIndex];
    }

    if (activeInfo) {
      activeInfo.answered = true;
      activeInfo.selectedAnswer = answerText;

      const updatedText = formatNeedsInfoAnswered(
        this.repository,
        activeInfo.payload,
        answerText,
        'button'
      );

      try {
        await this.provider.editMessage(activeInfo.messageId, updatedText, {
          chatId: activeInfo.chatId ?? this.defaultChatId,
          actions: await this.answeredNeedsInfoRows(activeInfo.payload),
        });
      } catch (err: any) {
        ActivityLogger.error(`RemoteControlManager: failed to edit message #${activeInfo.messageId}:`, err);
      }
    }

    if (this.actionController) {
      try {
        await this.actionController.replyToNeedsInfo(issueNumber, answerText);
      } catch (err: any) {
        ActivityLogger.error(`RemoteControlManager: error in replyToNeedsInfo for issue #${issueNumber}:`, err);
      }
    }
  }

  public async handleTextReply(replyToMessageId: number, text: string, userId: number): Promise<void> {
    const activeInfo = this.messageNeedsInfo.get(replyToMessageId);
    if (activeInfo) {
      if (activeInfo.answered) {
        return; // Already answered
      }

      activeInfo.answered = true;
      activeInfo.selectedAnswer = text;

      const updatedText = formatNeedsInfoAnswered(
        this.repository,
        activeInfo.payload,
        text,
        'text'
      );

      try {
        await this.provider.editMessage(activeInfo.messageId, updatedText, {
          chatId: activeInfo.chatId ?? this.defaultChatId,
          actions: await this.answeredNeedsInfoRows(activeInfo.payload),
        });
      } catch (err: any) {
        ActivityLogger.error(`RemoteControlManager: failed to edit message #${activeInfo.messageId}:`, err);
      }

      if (this.actionController) {
        try {
          await this.actionController.replyToNeedsInfo(activeInfo.issueNumber, text);
        } catch (err: any) {
          ActivityLogger.error(`RemoteControlManager: error in replyToNeedsInfo for issue #${activeInfo.issueNumber}:`, err);
        }
      }
      return;
    }

    if (this.taskMessageMap.has(replyToMessageId)) {
      const issueNum = this.taskMessageMap.get(replyToMessageId)!;
      await this.handleSteerCommand([String(issueNum), text], userId, { messageId: replyToMessageId });
      return;
    }
  }

  public async sendQuotaPaused(
    payload: QuotaPausedNotificationPayload,
    chatIdOrOptions?: number | string | SendQuotaPausedOptions
  ): Promise<{ messageId: number } | undefined> {
    if (!this.notifications.quotaPaused) {
      return undefined;
    }
    const text = formatQuotaPaused(this.repository, payload);
    const chatId = typeof chatIdOrOptions === 'object' ? chatIdOrOptions.chatId : chatIdOrOptions;
    const customActions = typeof chatIdOrOptions === 'object' ? chatIdOrOptions.actions : undefined;
    const actions: InteractiveAction[][] = customActions ?? [
      [
        {
          id: 'v1:q',
          label: '⚡ Resume Immediately',
          payload: buildQuotaResumeCallbackData(payload.runnerName),
        },
      ],
      [navButton('⚙️ Limits', { view: 'limits' }), navButton('📊 Status', { view: 'status' })],
    ];

    return this.provider.sendMessage(text, {
      chatId: chatId ?? this.defaultChatId,
      parseMode: 'Markdown',
      actions,
    });
  }

  public async sendQuotaResumed(
    payload: QuotaResumedNotificationPayload,
    chatId?: number | string
  ): Promise<{ messageId: number } | undefined> {
    if (!this.notifications.quotaPaused) {
      return undefined;
    }
    const text = formatQuotaResumed(this.repository, payload);
    return this.provider.sendMessage(text, {
      chatId: chatId ?? this.defaultChatId,
      parseMode: 'Markdown',
      actions: [[navButton('📊 Status', { view: 'status' }), navButton('📋 Tasks', { view: 'tasks' })]],
    });
  }

  public async sendMessage(
    text: string,
    options?: RemoteMessageOptions
  ): Promise<{ messageId: number }> {
    return this.provider.sendMessage(text, {
      chatId: options?.chatId ?? this.defaultChatId,
      ...options,
    });
  }

  public async handleQuotaAction(
    payload: string,
    userId: number,
    context?: ActionContext
  ): Promise<boolean> {
    const parsed = parseQuotaActionPayload(payload);
    if (!parsed) {
      return false;
    }

    const idempotencyKey = context?.messageId
      ? `msg:${context.chatId ?? this.defaultChatId}:${context.messageId}`
      : `payload:${payload}:${userId}`;

    if (this.processedQuotaActions.has(idempotencyKey)) {
      return false;
    }
    this.processedQuotaActions.add(idempotencyKey);

    if (this.actionController) {
      this.actionController.resumeQuota(parsed.runner);
    }

    if (context?.messageId) {
      const updatedText = formatQuotaResumedByDeveloper(this.repository, {
        originalText: context.originalText,
        timestamp: new Date(),
        runnerName: parsed.runner,
      });
      try {
        await this.provider.editMessage(context.messageId, updatedText, {
          chatId: context.chatId ?? this.defaultChatId,
          parseMode: 'Markdown',
          actions: [[navButton('📊 Status', { view: 'status' }), navButton('🏠 Menu', { view: 'menu' })]],
        });
      } catch (err: any) {
        ActivityLogger.error('Failed to edit message inline on quota resume:', err);
      }
    }

    return true;
  }

  private async handleTaskStarted(payload: TaskStartedNotificationPayload): Promise<void> {
    await this.sendTaskStarted(payload);
  }

  private async handleTaskCompleted(payload: TaskCompletedNotificationPayload): Promise<void> {
    await this.sendTaskCompleted(payload);
  }

  private async handleSpecCompleted(payload: SpecCompletedNotificationPayload): Promise<void> {
    await this.sendSpecCompleted(payload);
  }

  private async handleNeedsInfo(payload: NeedsInfoNotificationPayload): Promise<void> {
    await this.sendNeedsInfo(payload);
  }

  private async handleQuotaPaused(payload: QuotaPausedNotificationPayload): Promise<void> {
    const now = Date.now();
    const resetAtMs = payload.resetAt ? new Date(payload.resetAt).getTime() : 0;
    if (
      this.lastPausedEvent &&
      Math.abs(this.lastPausedEvent.resetAt - resetAtMs) < 60000 &&
      this.lastPausedEvent.runner === payload.runnerName &&
      now - this.lastPausedEvent.timestamp < 30000
    ) {
      return;
    }
    this.lastPausedEvent = { resetAt: resetAtMs, runner: payload.runnerName, timestamp: now };
    await this.sendQuotaPaused(payload);
  }

  private async handleQuotaResumed(payload: QuotaResumedNotificationPayload): Promise<void> {
    const now = Date.now();
    if (
      this.lastResumedEvent &&
      this.lastResumedEvent.runner === payload.runnerName &&
      now - this.lastResumedEvent.timestamp < 10000
    ) {
      return;
    }
    this.lastResumedEvent = { runner: payload.runnerName, timestamp: now };
    await this.sendQuotaResumed(payload);
  }

  // ---------------------------------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------------------------------

  private chatOf(context?: ActionContext): number | string | undefined {
    return context?.chatId ?? this.defaultChatId;
  }

  private issueUrlFor(issueNumber: number): string | undefined {
    const repo = this.issueRepository ?? this.repository;
    return repo ? `https://github.com/${repo}/issues/${issueNumber}` : undefined;
  }

  /** Links for an issue, preferring what the caller already knows over a lookup. */
  private async getLinks(issueNumber: number, known: Partial<IssueLinks> = {}): Promise<IssueLinks> {
    let looked: IssueLinks = {};
    if (!known.prUrl && this.actionController?.getIssueLinks) {
      try {
        looked = await this.actionController.getIssueLinks(issueNumber);
      } catch {
        // Links are a convenience: a failed lookup leaves them out
      }
    }
    return {
      issueUrl: known.issueUrl ?? looked.issueUrl ?? this.issueUrlFor(issueNumber),
      prUrl: known.prUrl ?? looked.prUrl,
      prNumber: known.prNumber ?? looked.prNumber,
      prState: known.prUrl ? undefined : looked.prState,
    };
  }

  private getIssueState(issueNumber: number): IssueRunState | undefined {
    try {
      return this.actionController?.getIssueState?.(issueNumber);
    } catch {
      return undefined;
    }
  }

  private getTasks(): TasksSummary | undefined {
    return this.actionController?.getTasksSummary ? this.actionController.getTasksSummary() : undefined;
  }

  private pickerItems(tasks?: TasksSummary, includeQueued: boolean = true): PickerItem[] {
    return [
      ...(tasks?.inProgress ?? []).map((t) => ({ issueNumber: t.issueNumber, title: t.title, state: 'running' })),
      ...(tasks?.paused ?? []).map((t) => ({ issueNumber: t.issueNumber, title: t.title, state: 'paused' })),
      ...(includeQueued ? (tasks?.queued ?? []) : []).map((t) => ({ issueNumber: t.issueNumber, title: t.title, state: 'queued' })),
    ];
  }

  /** Buttons for a message about one issue: what can be done with it next, and where it lives on GitHub. */
  private async issueRows(
    issueNumber: number,
    current: 'inspect' | 'logs' | 'other',
    known: Partial<IssueLinks> = {}
  ): Promise<InteractiveAction[][]> {
    const links = await this.getLinks(issueNumber, known);
    return [
      ...buildIssueControlRows(issueNumber, this.getIssueState(issueNumber), current),
      buildLinkRow(issueNumber, links),
    ].filter((r) => r.length > 0);
  }

  private needsInfoFollowUpRows(issueNumber: number, links: IssueLinks): InteractiveAction[][] {
    return [
      buildLinkRow(issueNumber, links),
      [navButton('🔍 Inspect', { view: 'inspect', issueNumber }), navButton('📜 Logs', { view: 'logs', issueNumber })],
    ].filter((r) => r.length > 0);
  }

  private async answeredNeedsInfoRows(payload: NeedsInfoNotificationPayload): Promise<InteractiveAction[][]> {
    const links = await this.getLinks(payload.issueNumber, {
      issueUrl: payload.issueUrl,
      prUrl: payload.prUrl,
      prNumber: payload.prNumber,
    });
    return this.needsInfoFollowUpRows(payload.issueNumber, links);
  }

  /**
   * Shows a view. `navigate` replaces the message the tapped button was on when that message is itself a
   * view, so moving between views reads as navigation; a button on a notification opens a new view and
   * leaves the notification in the chat. `replace` always edits, for dialogs such as a confirmation.
   */
  private async present(
    view: View,
    context?: ActionContext,
    mode: 'send' | 'navigate' | 'replace' = 'send'
  ): Promise<void> {
    const text = clampText(view.text);
    const actions = view.actions.filter((r) => r.length > 0);
    const messageId = context?.messageId;
    const edit =
      messageId !== undefined && (mode === 'replace' || (mode === 'navigate' && this.viewMessageIds.has(messageId)));
    if (edit) {
      try {
        await this.provider.editMessage(messageId, text, {
          chatId: this.chatOf(context),
          parseMode: 'Markdown',
          actions,
        });
        this.trackView(messageId);
        return;
      } catch (err: any) {
        ActivityLogger.error('RemoteControlManager: failed to update view in place, sending it instead:', err);
      }
    }
    const sent = await this.provider.sendMessage(text, {
      chatId: this.chatOf(context),
      parseMode: 'Markdown',
      actions: actions.length > 0 ? actions : undefined,
    });
    if (sent?.messageId !== undefined) this.trackView(sent.messageId);
  }

  private trackView(messageId: number): void {
    this.viewMessageIds.delete(messageId);
    this.viewMessageIds.add(messageId);
    if (this.viewMessageIds.size > MAX_TRACKED_VIEWS) {
      const oldest = this.viewMessageIds.values().next().value;
      if (oldest !== undefined) this.viewMessageIds.delete(oldest);
    }
  }

  private withNotice(notice: string | undefined, text: string): string {
    return notice ? `${notice}\n\n${text}` : text;
  }

  // ---------------------------------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------------------------------

  private renderMenu(): View {
    const summary = (this.actionController?.getStatusSummary() || {}) as any;
    const limits = this.actionController?.getQuotaLimits?.();
    return { text: formatMenu(this.repository, summary, limits), actions: buildMainMenuRows() };
  }

  private renderStatus(notice?: string): View {
    const summary = (this.actionController?.getStatusSummary() || {}) as any;
    const workers: Array<{ issueNumber: number; title?: string; status?: string }> =
      summary.activeWorkers || summary.workers || [];
    const actions: InteractiveAction[][] = [
      ...buildIssuePickerRows(
        workers.map((w) => ({
          issueNumber: w.issueNumber,
          title: w.title,
          state: w.status === 'paused_quota' ? 'paused' : 'running',
        })),
        'inspect',
        6
      ),
    ];
    const controls: InteractiveAction[] = [];
    if (summary.quota?.isPaused) {
      controls.push(actionButton('⚡ Resume quota', { action: 'qresume' }));
    }
    controls.push(
      summary.isDispatchingPaused || summary.isSessionStarted === false
        ? actionButton('▶️ Resume dispatch', { action: 'dresume' })
        : actionButton('⏸️ Pause dispatch', { action: 'dpause' })
    );
    actions.push(controls);
    actions.push([
      navButton('📋 Tasks', { view: 'tasks' }),
      navButton('⚙️ Limits', { view: 'limits' }),
      actionButton('🧹 Clean', { action: 'clean' }),
    ]);
    actions.push(buildFooterRow({ refresh: { view: 'status' } }));
    return { text: this.withNotice(notice, formatStatus(this.repository, summary)), actions };
  }

  private renderTasks(notice?: string): View {
    let tasksData = this.getTasks();
    if (!tasksData) {
      const summary = (this.actionController?.getStatusSummary() || {}) as any;
      const activeWorkers = summary.activeWorkers || summary.workers || [];
      tasksData = {
        inProgress: activeWorkers.filter((w: any) => w.status === 'running'),
        paused: activeWorkers.filter((w: any) => w.status === 'paused_quota' || w.status === 'paused'),
        queued: [],
      };
    }
    const { text, actions } = formatTasks(this.repository, tasksData);
    return {
      text: this.withNotice(notice, text),
      actions: [...actions, buildFooterRow({ refresh: { view: 'tasks' } })],
    };
  }

  private renderSpecs(notice?: string): View {
    let specsData: SpecsSummary;
    if (this.actionController?.getSpecsSummary) {
      specsData = this.actionController.getSpecsSummary();
    } else {
      const summary = (this.actionController?.getStatusSummary() || {}) as any;
      specsData = { targetSpecs: summary.targetSpecs || [], specs: summary.allSpecs || [] };
    }
    const { text, actions } = formatSpecs(this.repository, specsData);
    return { text: this.withNotice(notice, text), actions: [...actions, buildFooterRow()] };
  }

  private renderBrowse(page: number): View {
    const { text, actions } = formatBrowse(this.repository, this.getBrowseIssues(), { page });
    return { text, actions: [...actions, buildFooterRow()] };
  }

  private renderHelp(userId: number): View {
    const allowedUserIds = this.provider.getAllowedUserIds?.();
    const whitelistStatus =
      allowedUserIds && allowedUserIds.length > 0
        ? `Enabled (${allowedUserIds.length} allowed user${allowedUserIds.length === 1 ? '' : 's'})`
        : 'Disabled (Open to all)';
    const securityInfo: SecurityStatusInfo = {
      userId,
      isAuthorized: true,
      whitelistStatus,
      allowedUserCount: allowedUserIds?.length,
    };
    const inProgress = this.getTasks()?.inProgress;
    const text = formatHelp(this.repository, securityInfo, inProgress);
    const workerRows = (inProgress ?? []).slice(0, 4).map((w) => [
      navButton(`🔍 #${w.issueNumber}`, { view: 'inspect', issueNumber: w.issueNumber }),
      actionButton(`🧭 Steer #${w.issueNumber}`, { action: 'steer', issueNumber: w.issueNumber }),
      actionButton(`⏸️ #${w.issueNumber}`, { action: 'pause', issueNumber: w.issueNumber }),
    ]);
    return { text, actions: [...workerRows, ...buildMainMenuRows().slice(0, 4)] };
  }

  private renderLimits(notice?: string): View {
    const limits = this.actionController?.getQuotaLimits?.();
    if (!limits) {
      return {
        text: `${formatRepoTag(this.repository)}⚠️ Usage limits are not available from the active controller.`,
        actions: [buildFooterRow()],
      };
    }
    return {
      text: formatLimits(this.repository, limits, notice),
      actions: [
        ...buildLimitAdjustRows(limits.fiveHourPercent, limits.weeklyPercent),
        buildFooterRow({ refresh: { view: 'limits' } }),
      ],
    };
  }

  private renderInspectPicker(): View {
    const tasks = this.getTasks();
    const text = formatInspectHelp(this.repository, {
      inProgress: tasks?.inProgress,
      paused: tasks?.paused,
      queued: tasks?.queued,
    });
    return {
      text,
      actions: [...buildIssuePickerRows(this.pickerItems(tasks), 'inspect'), buildFooterRow({ refresh: { view: 'inspect' } })],
    };
  }

  private renderLogsPicker(): View {
    const tasks = this.getTasks();
    const text = formatLogsHelp(this.repository, {
      inProgress: tasks?.inProgress,
      paused: tasks?.paused,
      queued: tasks?.queued,
    });
    return {
      text,
      actions: [...buildIssuePickerRows(this.pickerItems(tasks), 'logs'), buildFooterRow({ refresh: { view: 'logs' } })],
    };
  }

  private renderSteerPicker(): View {
    const tasks = this.getTasks();
    const text = formatSteerUsage(this.repository, tasks?.inProgress);
    return {
      text,
      actions: [...buildIssuePickerRows(this.pickerItems(tasks, false), 'steer'), buildFooterRow()],
    };
  }

  private async renderInspect(issueNumber: number, notice?: string): Promise<View | undefined> {
    if (!this.actionController?.getInspectSummary) return undefined;
    const details = await this.actionController.getInspectSummary(issueNumber);
    return {
      text: this.withNotice(notice, formatInspect(this.repository, issueNumber, details)),
      actions: [
        ...(await this.issueRows(issueNumber, 'inspect')),
        buildFooterRow({ back: { view: 'inspect' }, refresh: { view: 'inspect', issueNumber } }),
      ],
    };
  }

  private async renderLogs(issueNumber: number): Promise<View | undefined> {
    if (!this.actionController?.getLogsSummary) return undefined;
    const logs = await this.actionController.getLogsSummary(issueNumber, LOGS_TAIL_LINES);
    return {
      text: formatLogs(this.repository, issueNumber, logs),
      actions: [
        ...(await this.issueRows(issueNumber, 'logs')),
        buildFooterRow({ back: { view: 'logs' }, refresh: { view: 'logs', issueNumber } }),
      ],
    };
  }

  private async renderTarget(target: NavTarget, userId: number): Promise<View> {
    switch (target.view) {
      case 'menu':
        return this.renderMenu();
      case 'status':
        return this.renderStatus();
      case 'tasks':
        return this.renderTasks();
      case 'specs':
        return this.renderSpecs();
      case 'help':
        return this.renderHelp(userId);
      case 'limits':
        return this.renderLimits();
      case 'steer':
        return this.renderSteerPicker();
      case 'browse':
        return this.renderBrowse(target.page);
      case 'inspect':
        if (target.issueNumber !== undefined) {
          const view = await this.renderInspect(target.issueNumber);
          if (view) return view;
        }
        return this.renderInspectPicker();
      case 'logs':
        if (target.issueNumber !== undefined) {
          const view = await this.renderLogs(target.issueNumber);
          if (view) return view;
        }
        return this.renderLogsPicker();
    }
  }

  // ---------------------------------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------------------------------

  public async handleMenuCommand(_args: string[], _userId: number, context?: ActionContext): Promise<void> {
    await this.present(this.renderMenu(), context);
  }

  public async handleStatusCommand(_args: string[], _userId: number, context?: ActionContext): Promise<void> {
    await this.present(this.renderStatus(), context);
  }

  public async handleTasksCommand(_args: string[], _userId: number, context?: ActionContext): Promise<void> {
    await this.present(this.renderTasks(), context);
  }

  private getBrowseIssues(): BrowseIssueSummary[] {
    return this.actionController?.getBrowseIssues ? this.actionController.getBrowseIssues() : [];
  }

  public async handleBrowseCommand(args: string[], _userId: number, context?: ActionContext): Promise<void> {
    const page = parseInt(args[0], 10);
    await this.present(this.renderBrowse(isNaN(page) ? 1 : page), context);
  }

  public async handleLimitsCommand(args: string[], _userId: number, context?: ActionContext): Promise<void> {
    if (args.length === 0) {
      await this.present(this.renderLimits(), context);
      return;
    }
    const parsed = parseLimitArgs(args);
    if (parsed.error) {
      await this.present(this.renderLimits(`⚠️ ${parsed.error}`), context);
      return;
    }
    await this.present(await this.applyLimits(parsed), context);
  }

  private async applyLimits(limits: { fiveHourPercent?: number; weeklyPercent?: number }): Promise<View> {
    if (!this.actionController?.updateQuotaLimits) {
      return this.renderLimits('⚠️ Changing limits is not supported by the active controller.');
    }
    try {
      const result = await this.actionController.updateQuotaLimits(limits);
      return this.renderLimits(`✅ ${escapeMarkdown(result.message)} Saved to config.`);
    } catch (err: any) {
      return this.renderLimits(`⚠️ Failed to update limits: ${escapeMarkdown(err?.message || String(err))}`);
    }
  }

  public async handleEnqueueCommand(args: string[], _userId: number, context?: ActionContext): Promise<void> {
    if (args.length === 0) {
      const summary = this.getTasks();
      await this.present(
        {
          text: formatEnqueueUsage(this.repository, { queued: summary?.queued }),
          actions: [
            ...(summary?.queued ?? []).slice(0, 5).map((q) => [
              actionButton(`⚡ Run #${q.issueNumber} now`, { action: 'now', issueNumber: q.issueNumber }),
              navButton(`🔍 #${q.issueNumber}`, { view: 'inspect', issueNumber: q.issueNumber }),
            ]),
            buildFooterRow(),
          ],
        },
        context
      );
      return;
    }

    const { issueNumber: parsedIssueNumber, force, now, runner, unknownFlags } = parseEnqueueArgs(args);

    if (unknownFlags.length > 0) {
      await this.provider.sendMessage(
        `⚠️ Unknown option(s): ${unknownFlags.map((f) => `\`${f}\``).join(', ')}.\n\n*Usage*: \`${ENQUEUE_USAGE}\``,
        { chatId: this.chatOf(context), parseMode: 'Markdown' }
      );
      return;
    }

    if (parsedIssueNumber === undefined) {
      const summary = this.getTasks();
      await this.provider.sendMessage(formatEnqueueUsage(this.repository, { queued: summary?.queued }), {
        chatId: this.chatOf(context),
        parseMode: 'Markdown',
      });
      return;
    }

    if (!this.actionController?.enqueueTask) {
      await this.provider.sendMessage('⚠️ Enqueue action is not supported by the current controller.', {
        chatId: this.chatOf(context),
        parseMode: 'Markdown',
      });
      return;
    }

    await this.present(await this.enqueueView(parsedIssueNumber, { force, now, runner }), context);
  }

  // Runs an enqueue and shows either the confirmation it needs or its outcome with what to do next.
  private async enqueueView(
    issueNumber: number,
    options: { force?: boolean; now?: boolean; runner?: string }
  ): Promise<View> {
    const result = await this.actionController!.enqueueTask!(issueNumber, options);

    if (result.requiresConfirmation && !options.force) {
      const { text, actions } = formatEnqueueConfirmation(this.repository, {
        issueNumber,
        message: result.message,
        blockerNumbers: result.blockerNumbers,
        childNumbers: result.childNumbers,
        isSpec: result.isSpec,
        isClosed: result.isClosed,
      });
      const links = await this.getLinks(issueNumber);
      return { text, actions: [...actions, buildLinkRow(issueNumber, links)] };
    }

    const text = formatEnqueueResult(this.repository, { success: result.success, message: result.message, issueNumber });
    const links = await this.getLinks(issueNumber);
    return {
      text,
      actions: [
        [navButton(`🔍 Inspect #${issueNumber}`, { view: 'inspect', issueNumber }), navButton('📋 Tasks', { view: 'tasks' })],
        buildLinkRow(issueNumber, links),
      ],
    };
  }

  public async handleSteerCommand(args: string[], _userId: number, context?: ActionContext): Promise<void> {
    let issueNumber: number | undefined;
    let promptText = '';

    if (args.length > 0) {
      const firstArgNum = parseInt(args[0].replace(/^#/, ''), 10);
      if (!isNaN(firstArgNum)) {
        issueNumber = firstArgNum;
        promptText = args.slice(1).join(' ').trim();
      } else {
        promptText = args.join(' ').trim();
      }
    }

    const summary = this.getTasks();

    if (!issueNumber) {
      const inProgress = summary?.inProgress || [];
      if (inProgress.length === 1 && promptText) {
        issueNumber = inProgress[0].issueNumber;
      } else {
        await this.present(this.renderSteerPicker(), context);
        return;
      }
    }

    if (!promptText) {
      await this.sendSteerPrompt(issueNumber, context);
      return;
    }

    if (!this.actionController?.injectPrompt) {
      const repoTag = formatRepoTag(this.repository);
      await this.provider.sendMessage(`${repoTag}⚠️ Steering is not supported by the active controller.`, {
        chatId: this.chatOf(context),
        parseMode: 'Markdown',
      });
      return;
    }

    const startTime = Date.now();
    const waitSeconds = 8;

    let result = { success: true, message: `Injected steering into #${issueNumber}` };
    try {
      result = await this.actionController.injectPrompt(issueNumber, promptText);
    } catch (err: any) {
      result = { success: false, message: err?.message || 'Failed to inject steering prompt' };
    }

    // 1. Send immediate feedback
    const immediateText = formatSteeringFeedback(this.repository, {
      issueNumber,
      prompt: promptText,
      resultMessage: result.message,
      waitTimeSeconds: waitSeconds,
    });

    const links = await this.getLinks(issueNumber);
    await this.provider.sendMessage(immediateText, {
      chatId: this.chatOf(context),
      parseMode: 'Markdown',
      actions: [buildLinkRow(issueNumber, links)].filter((r) => r.length > 0),
    });

    if (!result.success) {
      return;
    }

    // 2. Schedule 8-second live tail observation report
    const steeredIssue = issueNumber;
    setTimeout(async () => {
      try {
        let reportData: {
          issueNumber: number;
          prompt: string;
          status?: string;
          branchName?: string;
          runnerName?: string;
          events: Array<{ timestamp: string; summary: string; type: string }>;
          diffStat?: string;
        } = { issueNumber: steeredIssue, prompt: promptText, events: [] };

        if (this.actionController?.getLiveTailReport) {
          const liveTail = await this.actionController.getLiveTailReport(steeredIssue, startTime);
          reportData = {
            issueNumber: steeredIssue,
            prompt: promptText,
            status: liveTail.status,
            branchName: liveTail.branchName,
            runnerName: liveTail.runnerName,
            events: liveTail.events,
            diffStat: liveTail.diffStat,
          };
        }

        const reportText = formatSteeringLiveTailReport(this.repository, reportData);
        const msg = await this.provider.sendMessage(reportText, {
          chatId: this.chatOf(context),
          parseMode: 'Markdown',
          actions: [
            [
              actionButton('🧭 Steer again', { action: 'steer', issueNumber: steeredIssue }),
              navButton('🔍 Inspect', { view: 'inspect', issueNumber: steeredIssue }),
            ],
            buildLinkRow(steeredIssue, links),
          ].filter((r) => r.length > 0),
        });
        if (msg?.messageId) this.taskMessageMap.set(msg.messageId, steeredIssue);
      } catch (err: any) {
        ActivityLogger.error(`RemoteControlManager: error sending live tail report for #${steeredIssue}:`, err);
      }
    }, waitSeconds * 1000);
  }

  /** Asks for steering instructions; replying to the prompt steers the issue. */
  private async sendSteerPrompt(issueNumber: number, context?: ActionContext): Promise<void> {
    const title =
      this.pickerItems(this.getTasks()).find((t) => t.issueNumber === issueNumber)?.title;
    const msg = await this.provider.sendMessage(formatSteerPrompt(this.repository, issueNumber, title), {
      chatId: this.chatOf(context),
      parseMode: 'Markdown',
      forceReply: { placeholder: `Instructions for #${issueNumber}` },
    });
    if (msg?.messageId) this.taskMessageMap.set(msg.messageId, issueNumber);
  }

  private async pauseOrResumeIssue(
    action: 'pause' | 'resume',
    issueNumber: number
  ): Promise<{ success: boolean; message: string }> {
    let result = {
      success: true,
      message: `${action === 'pause' ? 'Paused' : 'Resumed'} worker for Issue #${issueNumber}`,
    };
    const fn = action === 'pause' ? this.actionController?.pauseTask : this.actionController?.resumeTask;
    if (fn) {
      const res = await fn.call(this.actionController, issueNumber);
      if (res && typeof res === 'object') result = res;
    }
    return result;
  }

  private async taskActionView(action: 'pause' | 'resume', issueNumber: number): Promise<View> {
    const result = await this.pauseOrResumeIssue(action, issueNumber);
    return {
      text: formatTaskActionResponse(this.repository, action, issueNumber, result),
      actions: [...(await this.issueRows(issueNumber, 'other')), [navButton('📋 Tasks', { view: 'tasks' })]],
    };
  }

  public async handlePauseCommand(args: string[], _userId: number, context?: ActionContext): Promise<void> {
    if (args.length > 0) {
      const issueNum = parseInt(args[0].replace(/^#/, ''), 10);
      if (!isNaN(issueNum)) {
        await this.present(await this.taskActionView('pause', issueNum), context);
        return;
      }
    }

    if (this.actionController?.pauseDispatching) {
      this.actionController.pauseDispatching();
    }
    await this.present(
      {
        text: formatDispatchPaused(this.repository),
        actions: [
          [actionButton('▶️ Resume dispatch', { action: 'dresume' }), navButton('📊 Status', { view: 'status' })],
          ...buildIssuePickerRows(
            (this.getTasks()?.inProgress ?? []).map((t) => ({ issueNumber: t.issueNumber, title: t.title, state: 'running' })),
            'inspect',
            4
          ),
        ],
      },
      context
    );
  }

  public async handleResumeCommand(args: string[], _userId: number, context?: ActionContext): Promise<void> {
    if (args.length > 0) {
      const issueNum = parseInt(args[0].replace(/^#/, ''), 10);
      if (!isNaN(issueNum)) {
        await this.present(await this.taskActionView('resume', issueNum), context);
        return;
      }
    }

    if (this.actionController?.resumeDispatching) {
      this.actionController.resumeDispatching();
    }
    await this.present(
      {
        text: formatDispatchResumed(this.repository),
        actions: [[navButton('📊 Status', { view: 'status' }), navButton('📋 Tasks', { view: 'tasks' })]],
      },
      context
    );
  }

  public async handleSpecsCommand(args: string[], _userId: number, context?: ActionContext): Promise<void> {
    if (args.length > 0) {
      const firstArg = args[0].toLowerCase();
      if (['all', 'clear', 'reset', '0', 'none'].includes(firstArg)) {
        if (this.actionController?.setTargetSpecs) {
          this.actionController.setTargetSpecs([]);
        }
        await this.present(
          { text: formatSpecsUpdated(this.repository, []), actions: [[navButton('🎯 Specs', { view: 'specs' }), navButton('📋 Tasks', { view: 'tasks' })]] },
          context
        );
        return;
      }

      const numbers = args
        .join(' ')
        .split(/[\s,]+/)
        .map((s) => parseInt(s.replace(/^#/, ''), 10))
        .filter((n) => !isNaN(n));

      if (numbers.length > 0) {
        if (this.actionController?.setTargetSpecs) {
          this.actionController.setTargetSpecs(numbers);
        }
        await this.present(
          {
            text: formatSpecsUpdated(this.repository, numbers),
            actions: [
              numbers
                .slice(0, 4)
                .map((n) => urlButton(`🔗 Spec #${n}`, this.issueUrlFor(n) ?? ''))
                .filter((b) => b.url),
              [navButton('🎯 Specs', { view: 'specs' }), navButton('📋 Tasks', { view: 'tasks' })],
            ],
          },
          context
        );
        return;
      }
    }

    await this.present(this.renderSpecs(), context);
  }

  public async handleHelpCommand(_args: string[], userId: number, context?: ActionContext): Promise<void> {
    await this.present(this.renderHelp(userId), context);
  }

  private async cleanNotice(): Promise<string> {
    let count = 0;
    if (this.actionController?.cleanWorktrees) {
      try {
        const res = await this.actionController.cleanWorktrees();
        count = res.count ?? 0;
      } catch (err: any) {
        ActivityLogger.error('RemoteControlManager error executing cleanWorktrees:', err);
      }
    }
    return formatCleanResult(this.repository, count);
  }

  public async handleCleanCommand(_args: string[], _userId: number, context?: ActionContext): Promise<void> {
    await this.present(
      {
        text: await this.cleanNotice(),
        actions: [[navButton('📊 Status', { view: 'status' }), navButton('🏠 Menu', { view: 'menu' })]],
      },
      context
    );
  }

  public async handleInspectCommand(args: string[], _userId: number, context?: ActionContext): Promise<void> {
    if (args.length > 0) {
      const issueNum = parseInt(args[0].replace(/^#/, ''), 10);
      if (!isNaN(issueNum)) {
        try {
          const view = await this.renderInspect(issueNum);
          if (view) {
            await this.present(view, context);
            return;
          }
        } catch (err: any) {
          ActivityLogger.error(`RemoteControlManager error executing getInspectSummary for #${issueNum}:`, err);
        }
      }
    }
    await this.present(this.renderInspectPicker(), context);
  }

  public async handleLogsCommand(args: string[], _userId: number, context?: ActionContext): Promise<void> {
    if (args.length > 0) {
      const issueNum = parseInt(args[0].replace(/^#/, ''), 10);
      if (!isNaN(issueNum)) {
        try {
          const view = await this.renderLogs(issueNum);
          if (view) {
            await this.present(view, context);
            return;
          }
        } catch (err: any) {
          ActivityLogger.error(`RemoteControlManager error executing getLogsSummary for #${issueNum}:`, err);
        }
      }
    }
    await this.present(this.renderLogsPicker(), context);
  }

  // ---------------------------------------------------------------------------------------------------
  // Button callbacks
  // ---------------------------------------------------------------------------------------------------

  public async handleNavAction(payload: string, userId: number, context?: ActionContext): Promise<boolean> {
    const target = parseNavCallbackData(payload);
    if (!target) return false;
    try {
      await this.present(await this.renderTarget(target, userId), context, 'navigate');
    } catch (err: any) {
      ActivityLogger.error(`RemoteControlManager: failed to open view "${payload}":`, err);
      return false;
    }
    return true;
  }

  public async handleIssueOrDaemonAction(payload: string, _userId: number, context?: ActionContext): Promise<boolean> {
    const target = parseActionCallbackData(payload);
    if (!target) return false;

    try {
      switch (target.action) {
        case 'steer':
          await this.sendSteerPrompt(target.issueNumber, context);
          return true;
        case 'pause':
        case 'resume': {
          const result = await this.pauseOrResumeIssue(target.action, target.issueNumber);
          const notice = formatTaskActionResponse(this.repository, target.action, target.issueNumber, result);
          const view = await this.renderInspect(target.issueNumber, notice);
          await this.present(view ?? (await this.taskActionView(target.action, target.issueNumber)), context, 'navigate');
          return true;
        }
        case 'enqueue':
        case 'now': {
          if (!this.actionController?.enqueueTask) return false;
          const view = await this.enqueueView(target.issueNumber, { now: target.action === 'now' });
          await this.present(view, context, 'navigate');
          return true;
        }
        case 'dpause': {
          const res = this.actionController?.pauseDispatching?.();
          await this.present(this.renderStatus(res ? `⏸️ ${res.message}` : undefined), context, 'navigate');
          return true;
        }
        case 'dresume': {
          const res = this.actionController?.resumeDispatching?.();
          await this.present(this.renderStatus(res ? `▶️ ${res.message}` : undefined), context, 'navigate');
          return true;
        }
        case 'qresume': {
          this.actionController?.resumeQuota(undefined);
          await this.present(this.renderStatus('⚡ Quota pause cleared. Workers resumed.'), context, 'navigate');
          return true;
        }
        case 'clean': {
          const notice = await this.cleanNotice();
          await this.present(this.renderStatus(notice), context, 'navigate');
          return true;
        }
      }
    } catch (err: any) {
      ActivityLogger.error(`RemoteControlManager: action "${payload}" failed:`, err);
    }
    return false;
  }

  public async handleLimitAction(payload: string, _userId: number, context?: ActionContext): Promise<boolean> {
    const parsed = parseLimitCallbackData(payload);
    if (!parsed) return false;
    const view = await this.applyLimits(
      parsed.window === 'h' ? { fiveHourPercent: parsed.percent } : { weeklyPercent: parsed.percent }
    );
    await this.present(view, context, 'navigate');
    return true;
  }

  public async handleTaskAction(payload: string, _userId: number, context?: ActionContext): Promise<boolean> {
    const parsed = parseTaskActionPayload(payload);
    if (!parsed) return false;

    const result = await this.pauseOrResumeIssue(parsed.action, parsed.issueNumber);

    if (context?.messageId && this.actionController?.getTasksSummary) {
      const notice = formatTaskActionResponse(this.repository, parsed.action, parsed.issueNumber, result);
      await this.present(this.renderTasks(notice), context, 'replace');
    } else {
      await this.present(
        {
          text: formatTaskActionResponse(this.repository, parsed.action, parsed.issueNumber, result),
          actions: [...(await this.issueRows(parsed.issueNumber, 'other')), [navButton('📋 Tasks', { view: 'tasks' })]],
        },
        context
      );
    }

    return true;
  }

  public async handleSpecAction(payload: string, _userId: number, context?: ActionContext): Promise<boolean> {
    const parsed = parseSpecActionPayload(payload);
    if (!parsed) return false;

    if (this.actionController?.setTargetSpecs) {
      this.actionController.setTargetSpecs(parsed.action === 'all' ? [] : parsed.specNumbers);
    }

    if (context?.messageId && this.actionController?.getSpecsSummary) {
      await this.present(this.renderSpecs(), context, 'replace');
    } else {
      await this.provider.sendMessage(formatSpecsUpdated(this.repository, parsed.specNumbers), {
        chatId: this.chatOf(context),
        parseMode: 'Markdown',
        actions: [[navButton('🎯 Specs', { view: 'specs' }), navButton('📋 Tasks', { view: 'tasks' })]],
      });
    }

    return true;
  }

  public async handleEnqueueAction(payload: string, _userId: number, context?: ActionContext): Promise<boolean> {
    const parsed = parseEnqueueActionPayload(payload);
    if (!parsed) return false;

    if (parsed.action === 'c') {
      if (context?.messageId) {
        try {
          await this.provider.editMessage(
            context.messageId,
            `❌ Enqueue for Issue #${parsed.issueNumber} was cancelled by developer.`,
            {
              chatId: this.chatOf(context),
              parseMode: 'Markdown',
              actions: [
                [
                  navButton(`🔍 Inspect #${parsed.issueNumber}`, { view: 'inspect', issueNumber: parsed.issueNumber }),
                  navButton('📋 Tasks', { view: 'tasks' }),
                ],
              ],
            }
          );
        } catch (err: any) {
          ActivityLogger.error('RemoteControlManager: failed to edit enqueue cancel message inline:', err);
        }
      }
      return true;
    }

    if (parsed.action === 'f') {
      if (!this.actionController?.enqueueTask) {
        return false;
      }
      await this.present(await this.enqueueView(parsed.issueNumber, { force: true }), context, 'replace');
      return true;
    }

    return false;
  }

  public async handleBrowseAction(payload: string, _userId: number, context?: ActionContext): Promise<boolean> {
    const parsed = parseBrowseActionPayload(payload);
    if (!parsed) return false;
    await this.present(this.renderBrowse(parsed.page), context, 'replace');
    return true;
  }

  private handleAgentEvent(_event: AgentEvent): void {
    // AgentEventBus hook for potential event forwarding or logging
  }
}

