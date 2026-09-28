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
} from './formatters.js';
import { parseEnqueueArgs, ENQUEUE_USAGE } from '../pipeline/enqueue_help.js';
import type { QuotaMonitor } from '../quota/monitor.js';

export interface SendQuotaPausedOptions extends RemoteMessageOptions {
  actions?: InteractiveAction[][];
}

export class RemoteControlManager {
  private provider: RemoteControlProvider;
  private repository?: string;
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
      this.boundOnQuotaMonitorPaused = ({ resetAt, waitMs, runnerName, affectedIssues }: any) => {
        const waitMinutes = Math.ceil(
          (waitMs ?? (resetAt ? Math.max(1000, new Date(resetAt).getTime() - Date.now()) : 60000)) /
            (60 * 1000)
        );
        this.handleQuotaPaused({ resetAt: new Date(resetAt), waitMinutes, runnerName, affectedIssues }).catch((err) => {
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
    const msg = await this.provider.sendMessage(text, {
      chatId: chatId ?? this.defaultChatId,
      parseMode: 'Markdown',
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
    return this.provider.sendMessage(text, {
      chatId: chatId ?? this.defaultChatId,
      parseMode: 'Markdown',
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
    return this.provider.sendMessage(text, {
      chatId: chatId ?? this.defaultChatId,
      parseMode: 'Markdown',
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

      const ghUrl = payload.issueUrl || payload.prUrl || (this.repository ? `https://github.com/${this.repository}/issues/${payload.issueNumber}` : undefined);
      if (ghUrl) {
        generatedActions.push([
          {
            id: `gh_${payload.issueNumber}`,
            label: '🔗 Open on GitHub',
            payload: '',
            url: ghUrl,
          },
        ]);
      }

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
          actions: [],
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
          actions: [],
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
          actions: [],
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

  public async handleStatusCommand(
    _args: string[],
    _userId: number,
    context?: ActionContext
  ): Promise<void> {
    const summary = (this.actionController?.getStatusSummary() || {}) as any;
    const text = formatStatus(this.repository, summary);
    await this.provider.sendMessage(text, {
      chatId: context?.chatId ?? this.defaultChatId,
      parseMode: 'Markdown',
    });
  }

  public async handleTasksCommand(
    _args: string[],
    _userId: number,
    context?: ActionContext
  ): Promise<void> {
    let tasksData: TasksSummary;
    if (this.actionController?.getTasksSummary) {
      tasksData = this.actionController.getTasksSummary();
    } else {
      const summary = (this.actionController?.getStatusSummary() || {}) as any;
      const activeWorkers = summary.activeWorkers || summary.workers || [];
      const inProgress = activeWorkers.filter((w: any) => w.status === 'running');
      const paused = activeWorkers.filter((w: any) => w.status === 'paused_quota' || w.status === 'paused');
      tasksData = {
        inProgress,
        paused,
        queued: [],
      };
    }

    const { text, actions } = formatTasks(this.repository, tasksData);
    await this.provider.sendMessage(text, {
      chatId: context?.chatId ?? this.defaultChatId,
      parseMode: 'Markdown',
      actions: actions.length > 0 ? actions : undefined,
    });
  }

  private getBrowseIssues(): BrowseIssueSummary[] {
    return this.actionController?.getBrowseIssues ? this.actionController.getBrowseIssues() : [];
  }

  public async handleBrowseCommand(
    args: string[],
    _userId: number,
    context?: ActionContext
  ): Promise<void> {
    const page = parseInt(args[0], 10);
    const { text, actions } = formatBrowse(this.repository, this.getBrowseIssues(), {
      page: isNaN(page) ? 1 : page,
    });
    await this.provider.sendMessage(text, {
      chatId: context?.chatId ?? this.defaultChatId,
      parseMode: 'Markdown',
      actions: actions.length > 0 ? actions : undefined,
    });
  }

  public async handleEnqueueCommand(
    args: string[],
    _userId: number,
    context?: ActionContext
  ): Promise<void> {
    if (args.length === 0) {
      const summary = this.actionController?.getTasksSummary ? this.actionController.getTasksSummary() : undefined;
      await this.provider.sendMessage(formatEnqueueUsage(this.repository, { queued: summary?.queued }), {
        chatId: context?.chatId ?? this.defaultChatId,
        parseMode: 'Markdown',
      });
      return;
    }

    const { issueNumber: parsedIssueNumber, force, now, runner, unknownFlags } = parseEnqueueArgs(args);

    if (unknownFlags.length > 0) {
      await this.provider.sendMessage(
        `⚠️ Unknown option(s): ${unknownFlags.map((f) => `\`${f}\``).join(', ')}.\n\n*Usage*: \`${ENQUEUE_USAGE}\``,
        {
          chatId: context?.chatId ?? this.defaultChatId,
          parseMode: 'Markdown',
        }
      );
      return;
    }

    if (parsedIssueNumber === undefined) {
      const summary = this.actionController?.getTasksSummary ? this.actionController.getTasksSummary() : undefined;
      const text = formatEnqueueUsage(this.repository, { queued: summary?.queued });
      await this.provider.sendMessage(text, {
        chatId: context?.chatId ?? this.defaultChatId,
        parseMode: 'Markdown',
      });
      return;
    }

    const issueNumber = parsedIssueNumber;

    if (!this.actionController?.enqueueTask) {
      await this.provider.sendMessage(
        '⚠️ Enqueue action is not supported by the current controller.',
        {
          chatId: context?.chatId ?? this.defaultChatId,
          parseMode: 'Markdown',
        }
      );
      return;
    }

    const result = await this.actionController.enqueueTask(issueNumber, { force, now, runner });

    if (result.requiresConfirmation && !force) {
      const { text, actions } = formatEnqueueConfirmation(this.repository, {
        issueNumber,
        message: result.message,
        blockerNumbers: result.blockerNumbers,
        childNumbers: result.childNumbers,
        isSpec: result.isSpec,
        isClosed: result.isClosed,
      });

      await this.provider.sendMessage(text, {
        chatId: context?.chatId ?? this.defaultChatId,
        parseMode: 'Markdown',
        actions,
      });
      return;
    }

    const text = formatEnqueueResult(this.repository, {
      success: result.success,
      message: result.message,
      issueNumber,
    });

    await this.provider.sendMessage(text, {
      chatId: context?.chatId ?? this.defaultChatId,
      parseMode: 'Markdown',
    });
  }

  public async handleSteerCommand(
    args: string[],
    _userId: number,
    context?: ActionContext
  ): Promise<void> {
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

    const summary = this.actionController?.getTasksSummary ? this.actionController.getTasksSummary() : undefined;

    if (!issueNumber) {
      const inProgress = summary?.inProgress || [];
      if (inProgress.length === 1 && promptText) {
        issueNumber = inProgress[0].issueNumber;
      } else {
        const text = formatSteerUsage(this.repository, inProgress);
        await this.provider.sendMessage(text, {
          chatId: context?.chatId ?? this.defaultChatId,
          parseMode: 'Markdown',
        });
        return;
      }
    }

    if (!promptText) {
      const text = formatSteerUsage(this.repository, summary?.inProgress);
      await this.provider.sendMessage(text, {
        chatId: context?.chatId ?? this.defaultChatId,
        parseMode: 'Markdown',
      });
      return;
    }

    if (!this.actionController?.injectPrompt) {
      const repoTag = formatRepoTag(this.repository);
      await this.provider.sendMessage(
        `${repoTag}⚠️ Steering is not supported by the active controller.`,
        { chatId: context?.chatId ?? this.defaultChatId, parseMode: 'Markdown' }
      );
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

    await this.provider.sendMessage(immediateText, {
      chatId: context?.chatId ?? this.defaultChatId,
      parseMode: 'Markdown',
    });

    if (!result.success) {
      return;
    }

    // 2. Schedule 8-second live tail observation report
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
        } = {
          issueNumber: issueNumber!,
          prompt: promptText,
          events: [],
        };

        if (this.actionController?.getLiveTailReport) {
          const liveTail = await this.actionController.getLiveTailReport(issueNumber!, startTime);
          reportData = {
            issueNumber: issueNumber!,
            prompt: promptText,
            status: liveTail.status,
            branchName: liveTail.branchName,
            runnerName: liveTail.runnerName,
            events: liveTail.events,
            diffStat: liveTail.diffStat,
          };
        }

        const reportText = formatSteeringLiveTailReport(this.repository, reportData);
        await this.provider.sendMessage(reportText, {
          chatId: context?.chatId ?? this.defaultChatId,
          parseMode: 'Markdown',
        });
      } catch (err: any) {
        ActivityLogger.error(`RemoteControlManager: error sending live tail report for #${issueNumber}:`, err);
      }
    }, waitSeconds * 1000);
  }

  public async handlePauseCommand(
    args: string[],
    _userId: number,
    context?: ActionContext
  ): Promise<void> {
    if (args.length > 0) {
      const issueNum = parseInt(args[0].replace(/^#/, ''), 10);
      if (!isNaN(issueNum)) {
        let result = { success: true, message: `Paused worker for Issue #${issueNum}` };
        if (this.actionController?.pauseTask) {
          const res = await this.actionController.pauseTask(issueNum);
          if (res && typeof res === 'object') {
            result = res;
          }
        }
        const text = formatTaskActionResponse(this.repository, 'pause', issueNum, result);
        await this.provider.sendMessage(text, {
          chatId: context?.chatId ?? this.defaultChatId,
          parseMode: 'Markdown',
        });
        return;
      }
    }

    if (this.actionController?.pauseDispatching) {
      this.actionController.pauseDispatching();
    }
    const text = formatDispatchPaused(this.repository);
    await this.provider.sendMessage(text, {
      chatId: context?.chatId ?? this.defaultChatId,
      parseMode: 'Markdown',
    });
  }

  public async handleResumeCommand(
    args: string[],
    _userId: number,
    context?: ActionContext
  ): Promise<void> {
    if (args.length > 0) {
      const issueNum = parseInt(args[0].replace(/^#/, ''), 10);
      if (!isNaN(issueNum)) {
        let result = { success: true, message: `Resumed worker for Issue #${issueNum}` };
        if (this.actionController?.resumeTask) {
          const res = await this.actionController.resumeTask(issueNum);
          if (res && typeof res === 'object') {
            result = res;
          }
        }
        const text = formatTaskActionResponse(this.repository, 'resume', issueNum, result);
        await this.provider.sendMessage(text, {
          chatId: context?.chatId ?? this.defaultChatId,
          parseMode: 'Markdown',
        });
        return;
      }
    }

    if (this.actionController?.resumeDispatching) {
      this.actionController.resumeDispatching();
    }
    const text = formatDispatchResumed(this.repository);
    await this.provider.sendMessage(text, {
      chatId: context?.chatId ?? this.defaultChatId,
      parseMode: 'Markdown',
    });
  }

  public async handleSpecsCommand(
    args: string[],
    _userId: number,
    context?: ActionContext
  ): Promise<void> {
    if (args.length > 0) {
      const firstArg = args[0].toLowerCase();
      if (['all', 'clear', 'reset', '0', 'none'].includes(firstArg)) {
        if (this.actionController?.setTargetSpecs) {
          this.actionController.setTargetSpecs([]);
        }
        const text = formatSpecsUpdated(this.repository, []);
        await this.provider.sendMessage(text, {
          chatId: context?.chatId ?? this.defaultChatId,
          parseMode: 'Markdown',
        });
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
        const text = formatSpecsUpdated(this.repository, numbers);
        await this.provider.sendMessage(text, {
          chatId: context?.chatId ?? this.defaultChatId,
          parseMode: 'Markdown',
        });
        return;
      }
    }

    let specsData: SpecsSummary;
    if (this.actionController?.getSpecsSummary) {
      specsData = this.actionController.getSpecsSummary();
    } else {
      const summary = (this.actionController?.getStatusSummary() || {}) as any;
      specsData = {
        targetSpecs: summary.targetSpecs || [],
        specs: summary.allSpecs || [],
      };
    }

    const { text, actions } = formatSpecs(this.repository, specsData);
    await this.provider.sendMessage(text, {
      chatId: context?.chatId ?? this.defaultChatId,
      parseMode: 'Markdown',
      actions: actions.length > 0 ? actions : undefined,
    });
  }

  public async handleHelpCommand(
    _args: string[],
    userId: number,
    context?: ActionContext
  ): Promise<void> {
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

    const summary = this.actionController?.getTasksSummary ? this.actionController.getTasksSummary() : undefined;
    const text = formatHelp(this.repository, securityInfo, summary?.inProgress);
    await this.provider.sendMessage(text, {
      chatId: context?.chatId ?? this.defaultChatId,
      parseMode: 'Markdown',
    });
  }

  public async handleCleanCommand(
    _args: string[],
    _userId: number,
    context?: ActionContext
  ): Promise<void> {
    let count = 0;
    if (this.actionController?.cleanWorktrees) {
      try {
        const res = await this.actionController.cleanWorktrees();
        count = res.count ?? 0;
      } catch (err: any) {
        ActivityLogger.error('RemoteControlManager error executing cleanWorktrees:', err);
      }
    }
    const text = formatCleanResult(this.repository, count);
    await this.provider.sendMessage(text, {
      chatId: context?.chatId ?? this.defaultChatId,
      parseMode: 'Markdown',
    });
  }

  public async handleInspectCommand(
    args: string[],
    _userId: number,
    context?: ActionContext
  ): Promise<void> {
    const summary = this.actionController?.getTasksSummary ? this.actionController.getTasksSummary() : undefined;

    if (args.length > 0) {
      const issueNum = parseInt(args[0].replace(/^#/, ''), 10);
      if (!isNaN(issueNum) && this.actionController?.getInspectSummary) {
        try {
          const details = await this.actionController.getInspectSummary(issueNum);
          const text = formatInspect(this.repository, issueNum, details);
          await this.provider.sendMessage(text, {
            chatId: context?.chatId ?? this.defaultChatId,
            parseMode: 'Markdown',
          });
          return;
        } catch (err: any) {
          ActivityLogger.error(`RemoteControlManager error executing getInspectSummary for #${issueNum}:`, err);
        }
      }
    }

    const text = formatInspectHelp(this.repository, {
      inProgress: summary?.inProgress,
      paused: summary?.paused,
      queued: summary?.queued,
    });
    await this.provider.sendMessage(text, {
      chatId: context?.chatId ?? this.defaultChatId,
      parseMode: 'Markdown',
    });
  }

  public async handleLogsCommand(
    args: string[],
    _userId: number,
    context?: ActionContext
  ): Promise<void> {
    const summary = this.actionController?.getTasksSummary ? this.actionController.getTasksSummary() : undefined;

    if (args.length > 0) {
      const issueNum = parseInt(args[0].replace(/^#/, ''), 10);
      if (!isNaN(issueNum) && this.actionController?.getLogsSummary) {
        try {
          const logs = await this.actionController.getLogsSummary(issueNum, 30);
          const text = formatLogs(this.repository, issueNum, logs);
          await this.provider.sendMessage(text, {
            chatId: context?.chatId ?? this.defaultChatId,
            parseMode: 'Markdown',
          });
          return;
        } catch (err: any) {
          ActivityLogger.error(`RemoteControlManager error executing getLogsSummary for #${issueNum}:`, err);
        }
      }
    }

    const text = formatLogsHelp(this.repository, {
      inProgress: summary?.inProgress,
      paused: summary?.paused,
      queued: summary?.queued,
    });
    await this.provider.sendMessage(text, {
      chatId: context?.chatId ?? this.defaultChatId,
      parseMode: 'Markdown',
    });
  }

  public async handleTaskAction(
    payload: string,
    _userId: number,
    context?: ActionContext
  ): Promise<boolean> {
    const parsed = parseTaskActionPayload(payload);
    if (!parsed) return false;

    let result = { success: true, message: `Task #${parsed.issueNumber} ${parsed.action}d` };
    if (parsed.action === 'pause' && this.actionController?.pauseTask) {
      const res = await this.actionController.pauseTask(parsed.issueNumber);
      if (res && typeof res === 'object') {
        result = res;
      }
    } else if (parsed.action === 'resume' && this.actionController?.resumeTask) {
      const res = await this.actionController.resumeTask(parsed.issueNumber);
      if (res && typeof res === 'object') {
        result = res;
      }
    }

    if (context?.messageId && this.actionController?.getTasksSummary) {
      const updatedTasks = this.actionController.getTasksSummary();
      const { text, actions } = formatTasks(this.repository, updatedTasks);
      try {
        await this.provider.editMessage(context.messageId, text, {
          chatId: context.chatId ?? this.defaultChatId,
          parseMode: 'Markdown',
          actions: actions.length > 0 ? actions : [],
        });
      } catch (err: any) {
        ActivityLogger.error('RemoteControlManager: failed to edit tasks message inline:', err);
      }
    } else {
      const text = formatTaskActionResponse(this.repository, parsed.action, parsed.issueNumber, result);
      await this.provider.sendMessage(text, {
        chatId: context?.chatId ?? this.defaultChatId,
        parseMode: 'Markdown',
      });
    }

    return true;
  }

  public async handleSpecAction(
    payload: string,
    _userId: number,
    context?: ActionContext
  ): Promise<boolean> {
    const parsed = parseSpecActionPayload(payload);
    if (!parsed) return false;

    if (parsed.action === 'all') {
      if (this.actionController?.setTargetSpecs) {
        this.actionController.setTargetSpecs([]);
      }
    } else if (parsed.action === 'set') {
      if (this.actionController?.setTargetSpecs) {
        this.actionController.setTargetSpecs(parsed.specNumbers);
      }
    }

    if (context?.messageId && this.actionController?.getSpecsSummary) {
      const updatedSpecs = this.actionController.getSpecsSummary();
      const { text, actions } = formatSpecs(this.repository, updatedSpecs);
      try {
        await this.provider.editMessage(context.messageId, text, {
          chatId: context.chatId ?? this.defaultChatId,
          parseMode: 'Markdown',
          actions: actions.length > 0 ? actions : [],
        });
      } catch (err: any) {
        ActivityLogger.error('RemoteControlManager: failed to edit specs message inline:', err);
      }
    } else {
      const updateText = formatSpecsUpdated(this.repository, parsed.specNumbers);
      await this.provider.sendMessage(updateText, {
        chatId: context?.chatId ?? this.defaultChatId,
        parseMode: 'Markdown',
      });
    }

    return true;
  }

  public async handleEnqueueAction(
    payload: string,
    _userId: number,
    context?: ActionContext
  ): Promise<boolean> {
    const parsed = parseEnqueueActionPayload(payload);
    if (!parsed) return false;

    if (parsed.action === 'c') {
      if (context?.messageId) {
        try {
          await this.provider.editMessage(
            context.messageId,
            `❌ Enqueue for Issue #${parsed.issueNumber} was cancelled by developer.`,
            {
              chatId: context.chatId ?? this.defaultChatId,
              parseMode: 'Markdown',
              actions: [],
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

      const result = await this.actionController.enqueueTask(parsed.issueNumber, { force: true });
      const text = formatEnqueueResult(this.repository, {
        success: result.success,
        message: result.message,
        issueNumber: parsed.issueNumber,
      });

      if (context?.messageId) {
        try {
          await this.provider.editMessage(context.messageId, text, {
            chatId: context.chatId ?? this.defaultChatId,
            parseMode: 'Markdown',
            actions: [],
          });
        } catch (err: any) {
          ActivityLogger.error('RemoteControlManager: failed to edit enqueue result message inline:', err);
        }
      } else {
        await this.provider.sendMessage(text, {
          chatId: context?.chatId ?? this.defaultChatId,
          parseMode: 'Markdown',
        });
      }

      return true;
    }

    return false;
  }

  public async handleBrowseAction(
    payload: string,
    _userId: number,
    context?: ActionContext
  ): Promise<boolean> {
    const parsed = parseBrowseActionPayload(payload);
    if (!parsed) return false;

    const { text, actions } = formatBrowse(this.repository, this.getBrowseIssues(), { page: parsed.page });

    if (context?.messageId) {
      try {
        await this.provider.editMessage(context.messageId, text, {
          chatId: context.chatId ?? this.defaultChatId,
          parseMode: 'Markdown',
          actions: actions.length > 0 ? actions : [],
        });
      } catch (err: any) {
        ActivityLogger.error('RemoteControlManager: failed to edit browse page message inline:', err);
      }
    } else {
      await this.provider.sendMessage(text, {
        chatId: context?.chatId ?? this.defaultChatId,
        parseMode: 'Markdown',
        actions: actions.length > 0 ? actions : undefined,
      });
    }

    return true;
  }

  private handleAgentEvent(_event: AgentEvent): void {
    // AgentEventBus hook for potential event forwarding or logging
  }
}

