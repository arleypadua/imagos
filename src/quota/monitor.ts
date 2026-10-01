import { EventEmitter } from 'node:events';
import {
  DEFAULT_RESET_BUFFER_MS,
  rollForwardIfStale,
  type ClaudeLiveUsage,
  type QuotaMonitorOptions,
  type QuotaStatus,
  type RunnerLiveUsage,
  type RunnerPauseInfo,
  type UsageProvider,
} from './types.js';
import { ClaudeUsageProvider } from './providers/claude.js';
import { AgyUsageProvider } from './providers/agy.js';
import { signalProcessGroup } from '../runners/process_tree.js';

export * from './types.js';
export { ClaudeUsageProvider } from './providers/claude.js';
export { AgyUsageProvider } from './providers/agy.js';

export class QuotaMonitor extends EventEmitter {
  private isPaused: boolean = false;
  private pausedAt?: Date;
  private resetAt?: Date;
  private pauseReason?: string;
  private activePids: Map<number, string> = new Map();
  private stoppedPids: Set<number> = new Set();
  private resumeTimers: Map<string, NodeJS.Timeout> = new Map();
  private providers: Map<string, UsageProvider> = new Map();
  private runnerUsages: Map<string, RunnerLiveUsage> = new Map();
  private pausedRunners: Map<string, RunnerPauseInfo> = new Map();
  private overriddenRunners: Map<string, Date | undefined> = new Map();
  private claudeProvider: ClaudeUsageProvider;
  private agyProvider: AgyUsageProvider;
  private options: QuotaMonitorOptions;

  constructor(options: QuotaMonitorOptions = {}) {
    super();
    this.options = {
      pauseOnLimit: options.pauseOnLimit ?? true,
      utilizationThresholdLimit:
        options.utilizationThresholdLimit ?? options.utilizationThreshold ?? 0.85,
      allowedProviders: options.allowedProviders,
    };
    this.claudeProvider = new ClaudeUsageProvider();
    this.agyProvider = new AgyUsageProvider();
    this.registerProvider(this.claudeProvider);
    this.registerProvider(this.agyProvider);
  }

  public setOptions(options: Partial<QuotaMonitorOptions>): void {
    this.options = {
      ...this.options,
      ...options,
      utilizationThresholdLimit:
        options.utilizationThresholdLimit ??
        options.utilizationThreshold ??
        this.options.utilizationThresholdLimit ??
        0.85,
      allowedProviders:
        options.allowedProviders !== undefined
          ? options.allowedProviders
          : this.options.allowedProviders,
    };
  }

  public getOptions(): QuotaMonitorOptions {
    return { ...this.options };
  }

  public isRunnerAllowed(runnerName: string): boolean {
    const allowed = this.options.allowedProviders;
    if (!allowed || allowed.length === 0) return true;
    return allowed.map((p) => p.toLowerCase()).includes(runnerName.toLowerCase());
  }

  public isRunnerOverridden(runnerName: string): boolean {
    const rName = runnerName.toLowerCase();
    const until = this.overriddenRunners.get(rName);
    if (until === undefined && !this.overriddenRunners.has(rName)) {
      return false;
    }
    if (until && Date.now() >= until.getTime()) {
      this.overriddenRunners.delete(rName);
      return false;
    }
    return true;
  }

  public setRunnerOverride(runnerName?: string, override: boolean = true, until?: Date): void {
    if (runnerName) {
      const rName = runnerName.toLowerCase();
      if (override) {
        this.overriddenRunners.set(rName, until);
      } else {
        this.overriddenRunners.delete(rName);
      }
    } else {
      if (override) {
        for (const name of this.providers.keys()) {
          this.overriddenRunners.set(name.toLowerCase(), until);
        }
      } else {
        this.overriddenRunners.clear();
      }
    }
  }

  public clearRunnerOverrides(): void {
    this.overriddenRunners.clear();
  }

  public registerProvider(provider: UsageProvider): void {
    this.providers.set(provider.name, provider);
  }

  public getProvider(name: string): UsageProvider | undefined {
    return this.providers.get(name);
  }

  public registerPid(pid: number, runnerName: string = 'claude'): void {
    this.activePids.set(pid, runnerName.toLowerCase());
  }

  public unregisterPid(pid: number): void {
    this.activePids.delete(pid);
    this.stoppedPids.delete(pid);
  }

  public checkOutputForRateLimit(text: string): { isRateLimited: boolean; resetAt?: Date; reason?: string } {
    const lower = text.toLowerCase();

    const rateLimitPatterns = [
      'session limit',
      'hit your session limit',
      'usage limit reached',
      'rate limit reached',
      '429 too many requests',
      '5-hour limit',
      'five hour limit',
      'hit your 5-hour limit',
      'hit your usage limit',
      'rate_limit_error',
      'exhausted your quota',
      'resource_exhausted',
      'quota exceeded',
      'overloaded_error',
    ];

    const matched = rateLimitPatterns.some((pattern) => lower.includes(pattern));
    if (!matched) {
      return { isRateLimited: false };
    }

    let resetAt: Date | undefined = undefined;

    // 1. Try parsing ISO timestamp in output (e.g. 2026-08-20T01:20:27Z)
    const isoMatch = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/);
    if (isoMatch) {
      try {
        const parsed = new Date(isoMatch[0]);
        if (!isNaN(parsed.getTime()) && parsed.getTime() > Date.now()) {
          resetAt = parsed;
        }
      } catch {}
    }

    // 2. Try parsing "resets in X hours Y minutes" (e.g. "resets in 2 hours 30 minutes", "resets in 4h")
    if (!resetAt) {
      const inHoursMatch = lower.match(/resets?\s+(?:in|after)\s+(\d+)\s*h(?:ours?)?(?:\s*(\d+)\s*m(?:inutes?)?)?/i);
      if (inHoursMatch) {
        const hours = parseInt(inHoursMatch[1], 10);
        const minutes = inHoursMatch[2] ? parseInt(inHoursMatch[2], 10) : 0;
        const ms = (hours * 60 + minutes) * 60 * 1000;
        resetAt = new Date(Date.now() + ms);
      }
    }

    // 3. Try parsing "resets in X minutes"
    if (!resetAt) {
      const inMinsMatch = lower.match(/resets?\s+(?:in|after)\s+(\d+)\s*m(?:inutes?)?/i);
      if (inMinsMatch) {
        const minutes = parseInt(inMinsMatch[1], 10);
        resetAt = new Date(Date.now() + minutes * 60 * 1000);
      }
    }

    // 4. Try parsing "resets 5pm", "resets at 5pm", "resets 5:00pm", "resets 17:00", "resets at 17:00"
    if (!resetAt) {
      const timeMatch = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
      if (timeMatch) {
        let hour = parseInt(timeMatch[1], 10);
        const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
        const ampm = timeMatch[3]?.toLowerCase();

        if (ampm === 'pm' && hour < 12) hour += 12;
        if (ampm === 'am' && hour === 12) hour = 0;

        const target = new Date();
        target.setHours(hour, minute, 0, 0);
        resetAt = rollForwardIfStale(target);
      }
    }

    // Default fallback: 1 hour if unspecified
    if (!resetAt) {
      resetAt = new Date(Date.now() + 60 * 60 * 1000);
    }

    return {
      isRateLimited: true,
      resetAt,
      reason: 'Usage / Quota Limit Exceeded',
    };
  }

  public getEligibleRunners(): string[] {
    return Array.from(this.providers.keys()).filter((name) => this.isRunnerAllowed(name));
  }

  public areAllRunnersPaused(): boolean {
    const eligible = this.getEligibleRunners();
    if (eligible.length === 0) return false;
    return eligible.every((name) => this.isRunnerPaused(name));
  }

  public isRunnerPaused(runnerName: string): boolean {
    const pauseInfo = this.pausedRunners.get(runnerName.toLowerCase());
    if (!pauseInfo) return false;

    if (pauseInfo.resetAt.getTime() <= Date.now()) {
      this.resumeFromQuota(runnerName);
      return false;
    }

    return true;
  }

  private prunePausedRunners(): void {
    for (const name of Array.from(this.pausedRunners.keys())) {
      this.isRunnerPaused(name);
    }
  }

  // Nothing else notices a runner that was stopped but never resumed: the pause is gone from the map while
  // its processes are still frozen, so the daemon reports itself healthy and the workers never move again.
  public reconcileStoppedProcesses(): void {
    this.prunePausedRunners();

    for (const pid of Array.from(this.stoppedPids)) {
      const runner = this.activePids.get(pid);
      if (runner && this.isRunnerPaused(runner)) {
        continue;
      }
      signalProcessGroup(pid, 'SIGCONT');
      this.stoppedPids.delete(pid);
    }
  }

  public triggerQuotaPause(
    resetAt: Date,
    reason: string = 'Quota limit reached',
    runnerName: string = 'claude',
    affectedIssues?: number[],
    bufferMs: number = DEFAULT_RESET_BUFFER_MS
  ): void {
    const rName = runnerName.toLowerCase();
    if (!this.isRunnerAllowed(rName)) {
      return;
    }
    const effectiveResetAt = new Date(resetAt.getTime() + bufferMs);

    // A reset that has already passed describes a window that has already rolled. Pausing on it stops the
    // runners for a window they are no longer inside, and the resume it can schedule is a 1s no-op.
    if (effectiveResetAt.getTime() <= Date.now()) {
      return;
    }

    const existing = this.pausedRunners.get(rName);

    // If already paused and the reset time is effectively unchanged (within 60s), do not re-trigger/spam events
    if (existing && Math.abs(existing.resetAt.getTime() - effectiveResetAt.getTime()) < 60000) {
      if (affectedIssues && affectedIssues.length > 0) {
        const merged = Array.from(new Set([...(existing.affectedIssues || []), ...affectedIssues]));
        existing.affectedIssues = merged;
      }
      return;
    }

    const pauseInfo: RunnerPauseInfo = {
      runnerName: rName,
      pausedAt: new Date(),
      resetAt: effectiveResetAt,
      reason,
      affectedIssues,
    };
    this.pausedRunners.set(rName, pauseInfo);

    this.isPaused = true;
    this.pausedAt = new Date();
    this.resetAt = effectiveResetAt;
    this.pauseReason = reason;

    // Freeze the paused runner's agents together with the tool processes in their groups
    for (const [pid, runner] of this.activePids.entries()) {
      if (runner === rName && signalProcessGroup(pid, 'SIGSTOP')) {
        this.stoppedPids.add(pid);
      }
    }

    const waitMs = Math.max(1000, effectiveResetAt.getTime() - Date.now());

    // Scheduled before the event goes out: a listener that throws must not leave the runners stopped
    // with no resume on the clock.
    const existingTimer = this.resumeTimers.get(rName);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    this.resumeTimers.set(
      rName,
      setTimeout(() => {
        this.resumeTimers.delete(rName);
        this.resumeFromQuota(rName);
      }, waitMs)
    );

    this.emit('quota_paused', {
      pausedAt: this.pausedAt,
      resetAt: this.resetAt,
      reason: this.pauseReason,
      runnerName: rName,
      waitMs,
      affectedIssues,
    });
  }

  public resumeFromQuota(runnerName?: string, isManual: boolean = false): void {
    const targetRunner = runnerName ? runnerName.toLowerCase() : undefined;

    if (isManual) {
      const pauseInfo = targetRunner ? this.pausedRunners.get(targetRunner) : undefined;
      const until = pauseInfo?.resetAt || this.resetAt;
      this.setRunnerOverride(targetRunner, true, until);
    }

    const clearTimerFor = (name: string) => {
      const timer = this.resumeTimers.get(name);
      if (timer) {
        clearTimeout(timer);
        this.resumeTimers.delete(name);
      }
    };

    if (targetRunner) {
      this.pausedRunners.delete(targetRunner);
      clearTimerFor(targetRunner);
    } else {
      this.pausedRunners.clear();
      for (const name of Array.from(this.resumeTimers.keys())) {
        clearTimerFor(name);
      }
    }

    // Resume this runner's frozen agents and their tool processes
    for (const [pid, runner] of this.activePids.entries()) {
      if (!targetRunner || runner === targetRunner) {
        signalProcessGroup(pid, 'SIGCONT');
        this.stoppedPids.delete(pid);
      }
    }

    const previousResetAt = this.resetAt;

    if (this.pausedRunners.size === 0) {
      this.isPaused = false;
      this.pausedAt = undefined;
      this.resetAt = undefined;
      this.pauseReason = undefined;
    } else {
      // Pick the next soonest reset among remaining paused runners
      const nextPaused = Array.from(this.pausedRunners.values()).sort(
        (a, b) => a.resetAt.getTime() - b.resetAt.getTime()
      )[0];
      this.resetAt = nextPaused.resetAt;
      this.pauseReason = nextPaused.reason;
    }

    this.emit('quota_resumed', { resumedAt: new Date(), previousResetAt, runnerName: targetRunner });
  }

  public async fetchLiveUsage(forceRefresh = false): Promise<ClaudeLiveUsage | null> {
    this.reconcileStoppedProcesses();

    for (const [name, provider] of this.providers.entries()) {
      if (!this.isRunnerAllowed(name)) {
        this.runnerUsages.delete(name);
        continue;
      }
      try {
        const isAvailable = provider.isAvailable ? await provider.isAvailable() : true;
        if (!isAvailable) {
          this.runnerUsages.delete(name);
          continue;
        }

        const usage = await provider.fetchUsage(forceRefresh);
        if (usage) {
          this.runnerUsages.set(name, usage);
        }
      } catch {
        // Individual provider failure is non-fatal
      }
    }

    const rawThreshold = this.options.utilizationThresholdLimit ?? 0.85;
    const thresholdPercent = rawThreshold <= 1.0 ? Math.round(rawThreshold * 100) : Math.round(rawThreshold);
    const shouldPauseOnLimit = this.options.pauseOnLimit !== false;

    const claudeLive = (await this.claudeProvider.isAvailable()) ? this.claudeProvider.getCachedLiveUsage() : null;

    // Check if Claude quota threshold is reached
    if (this.isRunnerAllowed('claude') && claudeLive && shouldPauseOnLimit) {
      const isOverLimit = claudeLive.sessionUsedPercentage >= thresholdPercent;
      if (isOverLimit) {
        if (!this.isRunnerOverridden('claude')) {
          const resetAt = claudeLive.sessionResetAt || new Date(Date.now() + 60 * 60 * 1000);
          if (!this.isRunnerPaused('claude')) {
            this.triggerQuotaPause(
              resetAt,
              `Claude Live Session Quota: ${claudeLive.sessionUsedPercentage}% used (threshold: ${thresholdPercent}%, resets ${claudeLive.sessionResetText || 'soon'})`,
              'claude'
            );
          }
        }
      } else {
        this.overriddenRunners.delete('claude');
        if (this.isRunnerPaused('claude')) {
          const pauseInfo = this.pausedRunners.get('claude');
          const resetPassed = pauseInfo ? Date.now() >= pauseInfo.resetAt.getTime() : true;
          const newWindowBegan =
            claudeLive.sessionResetAt && pauseInfo
              ? claudeLive.sessionResetAt.getTime() > pauseInfo.resetAt.getTime()
              : false;

          if (resetPassed || newWindowBegan) {
            this.resumeFromQuota('claude');
          }
        }
      }
    }

    // Check if AGY quota threshold is reached
    const agyUsage = this.runnerUsages.get('agy');
    if (this.isRunnerAllowed('agy') && agyUsage && shouldPauseOnLimit) {
      const limitingBucket = agyUsage.buckets.find((b) => b.usedPercentage >= thresholdPercent);
      if (limitingBucket) {
        if (!this.isRunnerOverridden('agy')) {
          const resetAt = limitingBucket.resetAt || new Date(Date.now() + 60 * 60 * 1000);
          if (!this.isRunnerPaused('agy')) {
            this.triggerQuotaPause(
              resetAt,
              `AGY Quota: ${limitingBucket.usedPercentage}% used (threshold: ${thresholdPercent}%) for ${limitingBucket.name}`,
              'agy'
            );
          }
        }
      } else {
        this.overriddenRunners.delete('agy');
        if (this.isRunnerPaused('agy')) {
          const pauseInfo = this.pausedRunners.get('agy');
          const resetPassed = pauseInfo ? Date.now() >= pauseInfo.resetAt.getTime() : true;
          const newWindowBegan =
            pauseInfo &&
            agyUsage.buckets.some((b) => b.resetAt && b.resetAt.getTime() > pauseInfo.resetAt.getTime());

          if (resetPassed || newWindowBegan) {
            this.resumeFromQuota('agy');
          }
        }
      }
    }

    return claudeLive;
  }

  public getStatus(): QuotaStatus {
    this.prunePausedRunners();

    const runnerUsageRecord: Record<string, RunnerLiveUsage> = {};
    for (const [key, value] of this.runnerUsages.entries()) {
      runnerUsageRecord[key] = value;
    }

    const pausedRunnersRecord: Record<string, RunnerPauseInfo> = {};
    for (const [key, value] of this.pausedRunners.entries()) {
      pausedRunnersRecord[key] = value;
    }

    const pausedKeys = Array.from(this.pausedRunners.keys());
    const pausedRunner = pausedKeys.length > 0 ? pausedKeys.join(', ') : undefined;
    const overriddenRunners = Array.from(this.overriddenRunners.keys());

    return {
      isPaused: this.pausedRunners.size > 0,
      allRunnersPaused: this.areAllRunnersPaused(),
      pausedAt: this.pausedAt,
      resetAt: this.resetAt,
      reason: this.pauseReason,
      pausedRunner,
      pausedRunners: Object.keys(pausedRunnersRecord).length > 0 ? pausedRunnersRecord : undefined,
      overriddenRunners: overriddenRunners.length > 0 ? overriddenRunners : undefined,
      activePids: Array.from(this.activePids.keys()),
      liveUsage: this.claudeProvider.getCachedLiveUsage() || undefined,
      runnerUsage: Object.keys(runnerUsageRecord).length > 0 ? runnerUsageRecord : undefined,
    };
  }

  public getRemainingPauseTimeMs(): number {
    if (!this.isPaused || !this.resetAt) return 0;
    return Math.max(0, this.resetAt.getTime() - Date.now());
  }
}
