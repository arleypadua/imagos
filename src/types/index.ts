export type CanonicalLabel =
  | 'ready-for-agent'
  | 'needs-info'
  | 'ready-for-human'
  | 'needs-triage'
  | 'wontfix';

export interface GitHubLabel {
  name: string;
  color?: string;
  description?: string;
}

export interface GitHubComment {
  id: string;
  author: {
    login: string;
  };
  body: string;
  createdAt: string;
  updatedAt?: string;
}

export interface NativeIssueRelation {
  number: number;
  title?: string;
  state?: 'OPEN' | 'CLOSED' | string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  labels: GitHubLabel[];
  url: string;
  createdAt: string;
  updatedAt: string;
  comments?: GitHubComment[];
  blockedBy?: NativeIssueRelation[];
  blocking?: NativeIssueRelation[];
  parent?: { number: number; title?: string } | null;
  subIssues?: NativeIssueRelation[];
}

export type TaskKind = 'spec' | 'ticket' | 'standalone';

export interface ParsedDependencies {
  blockers: number[];
  parentNumber?: number;
  subTaskNumbers: number[];
  kind: TaskKind;
}

export type TaskStatus =
  | 'pending'
  | 'blocked'
  | 'ready'
  | 'running'
  | 'paused_quota'
  | 'waiting_feedback'
  | 'testing'
  | 'merging'
  | 'completed'
  | 'failed';

export interface DAGNode {
  issue: GitHubIssue;
  kind: TaskKind;
  blockers: number[];
  dependents: number[];
  parentNumber?: number;
  children: number[];
  status: TaskStatus;
  runnerName?: string;
}

export interface TaskContext {
  issue: GitHubIssue;
  kind: TaskKind;
  worktreePath: string;
  branchName: string;
  baseBranch: string;
  isContinuation?: boolean;
  userFeedback?: string;
  extraPrompt?: string;
  runnerName?: string;
  autoMerge?: boolean;
  mergeMethod?: 'squash' | 'merge' | 'rebase';
  /** Set when the issue lives in a different repository than the code, in `owner/repo` format. */
  issueRepository?: string;
}

export interface RunnerResult {
  success: boolean;
  status: 'COMPLETED' | 'NEEDS_INFO' | 'QUOTA_PAUSED' | 'FAILED' | 'TIMED_OUT' | 'INTERRUPTED_FOR_PROMPT';
  summary?: string;
  feedbackQuestion?: string;
  error?: string;
  quotaResetAt?: Date;
  injectedPrompt?: string;
  isTimeout?: boolean;
}

export interface AgyConfig {
  model?: string;
  effort?: 'low' | 'medium' | 'high' | string;
  printTimeout?: string;
}

export interface RunnerConfig {
  agy?: AgyConfig;
  claude?: Record<string, unknown>;
  [key: string]: unknown;
}

export type RunnerConfigs = RunnerConfig;

export interface TelegramNotificationsConfig {
  needsInfo: boolean;
  quotaPaused: boolean;
  taskCompleted: boolean;
  specCompleted: boolean;
}

export interface TelegramBotConfig {
  token: string;
  allowedChatIds?: (number | string)[];
  allowedUserIds?: number[];
  defaultChatId?: number | string;
  [key: string]: unknown;
}

export type TelegramBotCredentials = TelegramBotConfig;

export interface UserTelegramConfig {
  bots?: Record<string, TelegramBotConfig>;
  [key: string]: unknown;
}

export interface UserConfig {
  telegram?: UserTelegramConfig;
  [key: string]: unknown;
}

export interface TelegramRepoConfig {
  enabled?: boolean;
  bot?: string;
  botTokenEnv?: string;
  allowedChatIds?: (number | string)[];
  allowedUserIds?: number[];
  defaultChatId?: number | string;
  notifications?: TelegramNotificationsConfig;
}

export interface TelegramRemoteConfig {
  bot?: string;
  botTokenEnv: string;
  allowedChatIds?: (number | string)[];
  allowedUserIds?: number[];
  defaultChatId?: number | string;
  notifications: TelegramNotificationsConfig;
}

export interface RemoteControlConfig {
  enabled: boolean;
  provider: 'telegram' | 'slack' | 'discord';
  telegram: TelegramRemoteConfig;
}

export interface TelegramRepoCredentials {
  botToken?: string;
  allowedUserIds?: number[];
  defaultChatId?: number | string;
  chatId?: number | string;
}

export interface TelegramCredentials {
  defaultBotToken?: string;
  botToken?: string;
  defaultAllowedUserIds?: number[];
  allowedUserIds?: number[];
  defaultChatId?: number | string;
  chatId?: number | string;
  bots?: Record<string, TelegramBotConfig>;
  repositories?: Record<string, TelegramRepoCredentials>;
}

export interface Credentials {
  telegram?: TelegramCredentials;
  [key: string]: unknown;
}

export type CredentialSource =
  | 'env_file'
  | 'credentials_file_repo'
  | 'credentials_file_global'
  | 'user_config'
  | 'env_override'
  | 'process_env'
  | 'config'
  | 'none';

export interface ResolvedTelegramCredentials {
  bot?: string;
  botHandle?: string;
  botToken?: string;
  allowedChatIds?: (number | string)[];
  allowedUserIds?: number[];
  defaultChatId?: number | string;
  source: {
    botToken: CredentialSource;
    allowedUserIds: CredentialSource;
    allowedChatIds?: CredentialSource;
    defaultChatId: CredentialSource;
  };
}

export interface ResolveCredentialsOptions {
  cwd?: string;
  envPath?: string;
  credentialsPath?: string;
  userConfigPath?: string;
  homeDir?: string;
  repository?: string;
  bot?: string;
  config?: AutoPilotConfig | Partial<AutoPilotConfig>;
  env?: NodeJS.ProcessEnv;
  strict?: boolean;
}

export interface SaveTelegramCredentialsOptions {
  botToken?: string;
  allowedUserIds?: number[];
  defaultChatId?: number | string;
  repository?: string;
  customPath?: string;
  homeDir?: string;
}

export interface SaveTelegramBotOptions {
  botHandle: string;
  token: string;
  allowedChatIds?: (number | string)[];
  customPath?: string;
  homeDir?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  displayName: string;
  binaryName?: string;
  description: string;
  isInstalled: boolean;
  isAllowed: boolean;
  isDefault: boolean;
}

export interface AutoPilotConfig {
  repository?: string;
  /** Repository issues are sourced from, when it differs from `repository` (where code and PRs live). */
  issueRepository?: string;
  targetSpec?: number | number[];
  targetSpecs?: number[];
  baseBranch: string;
  maxConcurrency: number;
  maxAutoNudges?: number;
  maxRetriesOnFailure?: number;
  maxAutoRetries?: number;
  pollIntervalSeconds: number;
  extraPrompt?: string;
  runner: string;
  runnerConfig?: RunnerConfig;
  allowedProviders?: string[];
  allowedRunners?: string[];
  customRunnerCommand?: string;
  autoMerge: boolean;
  mergeMethod: 'squash' | 'merge' | 'rebase';
  cleanupWorktreeOnClose: boolean;
  telegram?: TelegramRepoConfig;
  remote: RemoteControlConfig;
  quota: {
    pauseOnLimit: boolean;
    utilizationThresholdLimit: number;
    utilizationThreshold?: number;
    tokenCeiling?: number;
    proxyPort?: number;
  };
  labels: {
    readyForAgent: string;
    needsInfo: string;
    readyForHuman: string;
    needsTriage: string;
    wontfix: string;
  };
}

export interface EnqueueTaskOptions {
  force?: boolean;
  now?: boolean;
  runner?: string;
}
export type TaskEnqueueOptions = EnqueueTaskOptions;

export interface EnqueueResult {
  success: boolean;
  message: string;
  requiresConfirmation?: boolean;
  blockerNumbers?: number[];
  childNumbers?: number[];
  isSpec?: boolean;
  isClosed?: boolean;
}
