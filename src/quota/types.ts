export const DEFAULT_RESET_BUFFER_MS = 2 * 60 * 1000; // 2 minute safety margin to avoid premature window wakeups
export const JUST_PASSED_RESET_GRACE_MS = 15 * 60 * 1000;

// A reset time that only just passed means the window has already rolled over. Reading it as tomorrow's
// clock time turns a boundary poll into a day-long pause.
export function rollForwardIfStale(target: Date, graceMs: number = JUST_PASSED_RESET_GRACE_MS): Date {
  const now = Date.now();
  if (target.getTime() > now || now - target.getTime() <= graceMs) {
    return target;
  }
  target.setDate(target.getDate() + 1);
  return target;
}

export type QuotaWindowType = 'five_hour' | 'weekly' | 'daily' | 'session' | 'other';

export interface QuotaBucket {
  name: string;
  group: string;
  windowType: QuotaWindowType;
  usedPercentage: number;
  remainingPercentage?: number;
  resetAt?: Date;
  resetText?: string;
}

export interface RunnerLiveUsage {
  runnerName: string;
  displayName: string;
  buckets: QuotaBucket[];
  lastFetchedAt: Date;
  rawText?: string;
}

export interface UsageProvider {
  readonly name: string;
  readonly displayName: string;
  fetchUsage(forceRefresh?: boolean): Promise<RunnerLiveUsage | null>;
  isAvailable?(): Promise<boolean>;
}

export interface ClaudeLiveUsage {
  sessionUsedPercentage: number;
  sessionResetText?: string;
  sessionResetAt?: Date;
  weekUsedPercentage?: number;
  weekResetText?: string;
  lastFetchedAt: Date;
}

export interface QuotaMonitorOptions {
  pauseOnLimit?: boolean;
  utilizationThresholdLimit?: number;
  utilizationThreshold?: number;
  proxyPort?: number;
  allowedProviders?: string[];
}

export interface RunnerPauseInfo {
  runnerName: string;
  pausedAt: Date;
  resetAt: Date;
  reason: string;
  affectedIssues?: number[];
}

export interface QuotaStatus {
  isPaused: boolean;
  allRunnersPaused?: boolean;
  pausedAt?: Date;
  resetAt?: Date;
  reason?: string;
  pausedRunner?: string;
  pausedRunners?: Record<string, RunnerPauseInfo>;
  overriddenRunners?: string[];
  activePids: number[];
  liveUsage?: ClaudeLiveUsage;
  runnerUsage?: Record<string, RunnerLiveUsage>;
}
