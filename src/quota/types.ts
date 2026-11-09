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

/** A weekly cap on one model, e.g. `Current week (Fable)`, on top of the all-models weekly cap. */
export interface ClaudeModelWeek {
  model: string;
  usedPercentage: number;
  resetText?: string;
  resetAt?: Date;
}

export interface ClaudeLiveUsage {
  /** Absent on accounts without a 5h session limit; the weekly limits are then the only ones. */
  sessionUsedPercentage?: number;
  sessionResetText?: string;
  sessionResetAt?: Date;
  weekUsedPercentage?: number;
  weekResetText?: string;
  weekResetAt?: Date;
  modelWeeks?: ClaudeModelWeek[];
  lastFetchedAt: Date;
}

export interface QuotaMonitorOptions {
  pauseOnLimit?: boolean;
  utilizationThresholdLimit?: number;
  utilizationThreshold?: number;
  /** Fraction (0.01–1.0) of the weekly window a runner may use before it is paused. */
  weeklyThresholdLimit?: number;
  proxyPort?: number;
  allowedProviders?: string[];
}

export const DEFAULT_FIVE_HOUR_THRESHOLD = 0.85;
export const DEFAULT_WEEKLY_THRESHOLD = 0.9;

/** Converts a threshold expressed as a fraction (0.9) or a percentage (90) to a whole percentage. */
export function toThresholdPercent(raw: number): number {
  return raw <= 1.0 ? Math.round(raw * 100) : Math.round(raw);
}

export interface RunnerPauseInfo {
  runnerName: string;
  pausedAt: Date;
  resetAt: Date;
  reason: string;
  affectedIssues?: number[];
  /** `threshold` pauses come from the configured limits, so changing those limits can lift them. */
  source?: 'threshold' | 'rate_limit';
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
