import type { TelegramNotificationsConfig, EnqueueTaskOptions, EnqueueResult } from '../types/index.js';
import type { TelegramRateLimiter } from './rate_limiter.js';
import type { AgentEventBus } from '../events/bus.js';
import type { QuotaMonitor } from '../quota/monitor.js';

export interface InteractiveAction {
  id: string; // Action prefix or identifier (e.g. 'v1:inf', 'v1:q')
  label: string; // Button text shown to user
  payload: string; // Callback data payload
  style?: 'primary' | 'danger' | 'default';
  url?: string; // If set, renders as a URL link button rather than callback button
}

export interface ActionContext {
  messageId?: number;
  chatId?: number | string;
  originalText?: string;
}

export interface RemoteMessageOptions {
  chatId?: string | number;
  parseMode?: 'MarkdownV2' | 'Markdown' | 'HTML';
  actions?: InteractiveAction[][]; // Rows of inline keyboard buttons
  replyToMessageId?: number;
}

export interface RemoteControlProvider {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(text: string, options?: RemoteMessageOptions): Promise<{ messageId: number }>;
  editMessage(messageId: number, text: string, options?: RemoteMessageOptions): Promise<void>;
  onAction(
    actionPrefix: string,
    handler: (action: string, payload: string, userId: number, context?: ActionContext) => Promise<void>
  ): void;
  onTextReply?(handler: (replyToMessageId: number, text: string, userId: number) => Promise<void>): void;
  onCommand?(
    command: string,
    handler: (args: string[], userId: number, context?: ActionContext) => Promise<void>
  ): void;
  getAllowedUserIds?(): number[] | undefined;
  getAllowedChatIds?(): (number | string)[] | undefined;
  registerCommands?(): Promise<void>;
}

export interface TaskItemSummary {
  issueNumber: number;
  title: string;
  branchName?: string;
  runnerName?: string;
  status: string;
  startedAt?: Date;
}

export interface TasksSummary {
  inProgress: TaskItemSummary[];
  paused: TaskItemSummary[];
  queued: TaskItemSummary[];
}

export interface SpecItemSummary {
  number: number;
  title: string;
  isComplete: boolean;
  totalTickets: number;
  completedTickets: number;
  state?: string;
}

export interface SpecsSummary {
  targetSpecs: number[];
  specs: SpecItemSummary[];
}

export interface SecurityStatusInfo {
  userId: number;
  isAuthorized: boolean;
  whitelistStatus: string;
  allowedUserCount?: number;
}

export interface StatusSummary {
  daemonStatus: 'idle' | 'running' | 'paused_quota';
  status: 'idle' | 'running' | 'paused_quota';
  isSessionStarted: boolean;
  isDispatchingPaused?: boolean;
  activeWorkerCount: number;
  maxConcurrency: number;
  activeWorkers: Array<{
    issueNumber: number;
    title: string;
    branchName: string;
    status: string;
    runnerName?: string;
    startedAt?: Date;
  }>;
  activeWorktrees: Array<{
    path: string;
    branch: string;
    issueNumber?: number;
  }>;
  targetSpecs: number[];
  quota: any;
  allSpecs?: SpecItemSummary[];
}

export interface ChildTicketSummary {
  number: number;
  title: string;
  status: string;
  state?: string;
  isClosed?: boolean;
  worker?: {
    branchName: string;
    status: string;
    runnerName?: string;
  };
  blockers?: number[];
}

export interface SpecTreeSummary {
  number: number;
  title: string;
  isComplete: boolean;
  totalTickets: number;
  completedTickets: number;
  state?: string;
  status: string;
  children: ChildTicketSummary[];
  worker?: {
    branchName: string;
    status: string;
    runnerName?: string;
  };
  blockers?: number[];
}

export interface StandaloneIssueSummary {
  number: number;
  title: string;
  status: string;
  state?: string;
  labels?: string[];
  worker?: {
    branchName: string;
    status: string;
    runnerName?: string;
  };
  blockers?: number[];
}

export interface BrowseIssueSummary {
  number: number;
  title: string;
}

export interface IssueTreeSummary {
  specs: SpecTreeSummary[];
  standaloneIssues: StandaloneIssueSummary[];
  totalOpenSpecs: number;
  totalOpenIssues: number;
  readyIssueNumbers: number[];
}

export interface RemoteActionController {
  replyToNeedsInfo(issueNumber: number, answer: string): Promise<void>;
  resumeQuota(runner?: string): void;
  pauseTask(issueNumber: number): Promise<{ success: boolean; message: string } | void>;
  resumeTask(issueNumber: number): Promise<{ success: boolean; message: string } | void>;
  pauseDispatching?(): { success: boolean; message: string };
  resumeDispatching?(): { success: boolean; message: string };
  setTargetSpecs(specs: number[]): void;
  getStatusSummary(): unknown;
  getTasksSummary?(): TasksSummary;
  getSpecsSummary?(): SpecsSummary;
  getIssueTreeSummary?(): IssueTreeSummary;
  getBrowseIssues?(): BrowseIssueSummary[];
  cleanWorktrees?(): Promise<{ success: boolean; message: string; count?: number }>;
  getInspectSummary?(issueNumber?: number): Promise<string>;
  getLogsSummary?(issueNumber: number, tailLines?: number): Promise<string>;
  enqueueTask?(
    issueNumber: number,
    options?: EnqueueTaskOptions
  ): Promise<EnqueueResult>;
  injectPrompt?(
    issueNumber: number,
    prompt: string
  ): Promise<{ success: boolean; message: string }>;
  getLiveTailReport?(
    issueNumber: number,
    sinceTimestamp?: number
  ): Promise<{
    issueNumber: number;
    status?: string;
    branchName?: string;
    runnerName?: string;
    events: Array<{ timestamp: string; summary: string; type: string }>;
    diffStat?: string;
  }>;
}

export interface TaskStartedNotificationPayload {
  issueNumber: number;
  issueTitle: string;
  runnerName: string;
  branchName: string;
  sessionId?: string;
  isContinuation?: boolean;
}

export interface TaskCompletedNotificationPayload {
  issueNumber: number;
  issueTitle: string;
  prNumber?: number;
  prUrl?: string;
  baseBranch?: string;
}

export interface SpecCompletedNotificationPayload {
  specNumber: number;
  specTitle: string;
}

export interface NeedsInfoNotificationPayload {
  issueNumber: number;
  issueTitle: string;
  question?: string;
  prNumber?: number;
  prUrl?: string;
  issueUrl?: string;
  choices?: string[];
}

export interface ActiveNeedsInfoRecord {
  issueNumber: number;
  messageId: number;
  chatId?: number | string;
  payload: NeedsInfoNotificationPayload;
  choices: string[];
  originalText: string;
  answered: boolean;
  selectedAnswer?: string;
  createdAt: number;
}

export interface QuotaPausedNotificationPayload {
  resetAt: Date;
  waitMinutes: number;
  runnerName?: string;
  affectedIssues?: number[];
}

export interface QuotaResumedNotificationPayload {
  runnerName?: string;
}

export interface TelegramRemoteProviderOptions {
  botToken?: string;
  botHandle?: string;
  allowedChatIds?: (number | string)[];
  allowedUserIds?: number[];
  defaultChatId?: number | string;
  rateLimiter?: TelegramRateLimiter;
  bot?: any;
  autoRetryOptions?: any;
}

export interface RemoteControlManagerOptions {
  provider: RemoteControlProvider;
  repository?: string;
  defaultChatId?: number | string;
  notifications?: Partial<TelegramNotificationsConfig>;
  eventBus?: AgentEventBus;
  actionController?: RemoteActionController;
  quotaMonitor?: QuotaMonitor;
}

