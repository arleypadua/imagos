import { describe, it, expect, vi, afterEach } from 'vitest';
import { QuotaMonitor } from '../src/quota/monitor.js';

describe('QuotaMonitor', () => {
  it('should detect 429 and rate limit error strings', () => {
    const monitor = new QuotaMonitor();
    const result = monitor.checkOutputForRateLimit('Error: 429 Too Many Requests. Usage limit reached.');
    expect(result.isRateLimited).toBe(true);
    expect(result.resetAt).toBeDefined();
  });

  it('should parse reset duration in minutes', () => {
    const monitor = new QuotaMonitor();
    const result = monitor.checkOutputForRateLimit('Rate limit reached. Resets in 45 minutes.');
    expect(result.isRateLimited).toBe(true);
    expect(result.resetAt).toBeDefined();

    const diffMinutes = Math.round((result.resetAt!.getTime() - Date.now()) / (60 * 1000));
    expect(diffMinutes).toBeCloseTo(45, -1);
  });

  it('should detect Claude Code "hit your session limit · resets 5pm (Europe/Amsterdam)"', () => {
    const monitor = new QuotaMonitor();
    const result = monitor.checkOutputForRateLimit("You've hit your session limit · resets 5pm (Europe/Amsterdam)");
    expect(result.isRateLimited).toBe(true);
    expect(result.resetAt).toBeDefined();
    expect(result.resetAt!.getHours()).toBe(17);
  });

  it('should return false for normal output', () => {
    const monitor = new QuotaMonitor();
    const result = monitor.checkOutputForRateLimit('Successfully executed test suite: 12 tests passed.');
    expect(result.isRateLimited).toBe(false);
    expect(result.resetAt).toBeUndefined();
  });

  describe('ClaudeUsageProvider Session Limit Parsing', () => {
    it('should parse "You\'ve hit your session limit · resets 11am (Europe/Amsterdam)" as 100% usage', () => {
      const monitor = new QuotaMonitor();
      const provider = monitor.getProvider('claude') as any;
      expect(provider).toBeDefined();

      const { liveUsage, runnerUsage } = provider.parseUsageOutput("You've hit your session limit · resets 11am (Europe/Amsterdam)");
      expect(liveUsage.sessionUsedPercentage).toBe(100);
      expect(liveUsage.sessionResetAt).toBeDefined();
      expect(liveUsage.sessionResetAt.getHours()).toBe(11);
      expect(liveUsage.sessionResetText).toContain('11am');
      expect(runnerUsage.buckets[0].usedPercentage).toBe(100);
      expect(runnerUsage.buckets[0].remainingPercentage).toBe(0);
    });

    it('should parse standard "Current session: 45% used · resets 3pm" properly', () => {
      const monitor = new QuotaMonitor();
      const provider = monitor.getProvider('claude') as any;
      const { liveUsage } = provider.parseUsageOutput("Current session: 45% used · resets 3pm");
      expect(liveUsage.sessionUsedPercentage).toBe(45);
      expect(liveUsage.sessionResetAt).toBeDefined();
      expect(liveUsage.sessionResetAt.getHours()).toBe(15);
    });
  });

  describe('QuotaMonitor Deduplication & Guard', () => {
    it('should deduplicate pause events and aggregate affectedIssues', () => {
      const monitor = new QuotaMonitor();
      const pausedEvents: any[] = [];
      monitor.on('quota_paused', (e) => pausedEvents.push(e));

      const resetAt = new Date(Date.now() + 60 * 60 * 1000);
      monitor.triggerQuotaPause(resetAt, 'Quota limit', 'claude', [201]);
      expect(pausedEvents.length).toBe(1);
      expect(pausedEvents[0].affectedIssues).toEqual([201]);

      // Second trigger with same reset time should NOT emit duplicate event, but merges affected issues
      monitor.triggerQuotaPause(resetAt, 'Quota limit', 'claude', [202]);
      expect(pausedEvents.length).toBe(1);

      const status = monitor.getStatus();
      expect(status.pausedRunners?.claude?.affectedIssues).toEqual([201, 202]);
    });

    it('should not prematurely unpause a runner if resetAt is in the future', async () => {
      const monitor = new QuotaMonitor();
      const futureReset = new Date(Date.now() + 2 * 60 * 60 * 1000);
      monitor.triggerQuotaPause(futureReset, 'Session limit', 'claude', [201, 202]);
      expect(monitor.isRunnerPaused('claude')).toBe(true);

      // Simulating a live usage poll that returns cached or empty telemetry
      const provider = monitor.getProvider('claude') as any;
      provider.fetchUsage = async () => null;
      provider.isAvailable = async () => true;
      provider.getCachedLiveUsage = () => ({
        sessionUsedPercentage: 0,
        sessionResetText: undefined,
        sessionResetAt: undefined,
        lastFetchedAt: new Date(),
      });

      const agyProvider = monitor.getProvider('agy') as any;
      agyProvider.fetchUsage = async () => null;

      await monitor.fetchLiveUsage(false);
      // Runner MUST remain paused because resetAt is 2 hours in the future!
      expect(monitor.isRunnerPaused('claude')).toBe(true);
    });

    it('should add 2-minute safety buffer to quota resetAt to prevent waking up on boundary', () => {
      const monitor = new QuotaMonitor();
      const rawReset = new Date(Date.now() + 10 * 60 * 1000);
      let emittedResetAt: Date | undefined;
      monitor.on('quota_paused', (e) => {
        emittedResetAt = e.resetAt;
      });

      monitor.triggerQuotaPause(rawReset, 'Session limit', 'claude', [100]);
      expect(emittedResetAt).toBeDefined();
      expect(emittedResetAt!.getTime()).toBe(rawReset.getTime() + 2 * 60 * 1000);

      const status = monitor.getStatus();
      expect(status.resetAt!.getTime()).toBe(rawReset.getTime() + 2 * 60 * 1000);
    });
  });

  describe('utilizationThresholdLimit & pauseOnLimit', () => {
    it('should proactively pause Claude runner when usage hits or exceeds utilizationThresholdLimit', async () => {
      const monitor = new QuotaMonitor({
        pauseOnLimit: true,
        utilizationThresholdLimit: 0.7, // 70%
      });

      const provider = monitor.getProvider('claude') as any;
      const resetTime = new Date(Date.now() + 2 * 60 * 60 * 1000);
      provider.fetchUsage = async () => ({
        runnerName: 'claude',
        displayName: 'Claude Code CLI',
        buckets: [{ name: 'Session 5h', group: 'Claude Models', windowType: 'five_hour', usedPercentage: 74, resetAt: resetTime }],
        lastFetchedAt: new Date(),
      });
      provider.isAvailable = async () => true;
      provider.getCachedLiveUsage = () => ({
        sessionUsedPercentage: 74,
        sessionResetText: 'resets in 2 hours',
        sessionResetAt: resetTime,
        lastFetchedAt: new Date(),
      });

      const agyProvider = monitor.getProvider('agy') as any;
      agyProvider.fetchUsage = async () => null;

      await monitor.fetchLiveUsage(false);
      expect(monitor.isRunnerPaused('claude')).toBe(true);

      const status = monitor.getStatus();
      expect(status.isPaused).toBe(true);
      expect(status.pausedRunner).toBe('claude');
      expect(status.reason).toContain('74% used (threshold: 70%');
    });

    it('should NOT pause Claude runner when usage is below utilizationThresholdLimit', async () => {
      const monitor = new QuotaMonitor({
        pauseOnLimit: true,
        utilizationThresholdLimit: 0.7, // 70%
      });

      const provider = monitor.getProvider('claude') as any;
      const resetTime = new Date(Date.now() + 2 * 60 * 60 * 1000);
      provider.fetchUsage = async () => null;
      provider.isAvailable = async () => true;
      provider.getCachedLiveUsage = () => ({
        sessionUsedPercentage: 65,
        sessionResetText: 'resets in 2 hours',
        sessionResetAt: resetTime,
        lastFetchedAt: new Date(),
      });

      const agyProvider = monitor.getProvider('agy') as any;
      agyProvider.fetchUsage = async () => null;

      await monitor.fetchLiveUsage(false);
      expect(monitor.isRunnerPaused('claude')).toBe(false);
    });

    it('should NOT pause when pauseOnLimit is false, even if threshold is exceeded', async () => {
      const monitor = new QuotaMonitor({
        pauseOnLimit: false,
        utilizationThresholdLimit: 0.7, // 70%
      });

      const provider = monitor.getProvider('claude') as any;
      provider.fetchUsage = async () => null;
      provider.isAvailable = async () => true;
      provider.getCachedLiveUsage = () => ({
        sessionUsedPercentage: 95,
        sessionResetText: 'resets in 1 hour',
        sessionResetAt: new Date(Date.now() + 60 * 60 * 1000),
        lastFetchedAt: new Date(),
      });

      const agyProvider = monitor.getProvider('agy') as any;
      agyProvider.fetchUsage = async () => null;

      await monitor.fetchLiveUsage(false);
      expect(monitor.isRunnerPaused('claude')).toBe(false);
    });

    it('should automatically resume runner when usage drops below utilizationThresholdLimit', async () => {
      const monitor = new QuotaMonitor({
        pauseOnLimit: true,
        utilizationThresholdLimit: 0.75, // 75%
      });

      const resetTime = new Date(Date.now() + 3 * 60 * 60 * 1000);
      monitor.triggerQuotaPause(resetTime, 'Quota limit reached', 'claude');
      expect(monitor.isRunnerPaused('claude')).toBe(true);

      // Usage dropped to 50% in a new window
      const newResetTime = new Date(Date.now() + 5 * 60 * 60 * 1000);
      const provider = monitor.getProvider('claude') as any;
      provider.fetchUsage = async () => null;
      provider.isAvailable = async () => true;
      provider.getCachedLiveUsage = () => ({
        sessionUsedPercentage: 50,
        sessionResetText: 'resets in 5 hours',
        sessionResetAt: newResetTime,
        lastFetchedAt: new Date(),
      });

      const agyProvider = monitor.getProvider('agy') as any;
      agyProvider.fetchUsage = async () => null;

      await monitor.fetchLiveUsage(false);
      expect(monitor.isRunnerPaused('claude')).toBe(false);
      expect(monitor.getStatus().isPaused).toBe(false);
    });

    it('should proactively pause AGY runner when any bucket hits utilizationThresholdLimit', async () => {
      const monitor = new QuotaMonitor({
        pauseOnLimit: true,
        utilizationThresholdLimit: 0.8, // 80%
      });

      const claudeProvider = monitor.getProvider('claude') as any;
      claudeProvider.isAvailable = async () => false;

      const agyReset = new Date(Date.now() + 60 * 60 * 1000);
      const agyProvider = monitor.getProvider('agy') as any;
      agyProvider.isAvailable = async () => true;
      agyProvider.fetchUsage = async () => ({
        runnerName: 'agy',
        displayName: 'Antigravity CLI',
        buckets: [
          { name: 'Gemini 5h', group: 'Gemini Models', windowType: 'five_hour', usedPercentage: 85, resetAt: agyReset },
        ],
        lastFetchedAt: new Date(),
      });

      await monitor.fetchLiveUsage(false);
      expect(monitor.isRunnerPaused('agy')).toBe(true);
      expect(monitor.getStatus().reason).toContain('85% used (threshold: 80%) for Gemini 5h');
    });

    it('should allow manual resume to override threshold pause without getting immediately re-paused', async () => {
      const monitor = new QuotaMonitor({
        pauseOnLimit: true,
        utilizationThresholdLimit: 0.7, // 70%
      });

      const provider = monitor.getProvider('claude') as any;
      const resetTime = new Date(Date.now() + 2 * 60 * 60 * 1000);
      provider.fetchUsage = async () => ({
        runnerName: 'claude',
        displayName: 'Claude Code CLI',
        buckets: [{ name: 'Session 5h', group: 'Claude Models', windowType: 'five_hour', usedPercentage: 80, resetAt: resetTime }],
        lastFetchedAt: new Date(),
      });
      provider.isAvailable = async () => true;
      provider.getCachedLiveUsage = () => ({
        sessionUsedPercentage: 80,
        sessionResetText: 'resets in 2 hours',
        sessionResetAt: resetTime,
        lastFetchedAt: new Date(),
      });

      const agyProvider = monitor.getProvider('agy') as any;
      agyProvider.fetchUsage = async () => null;

      // 1. Initial poll pauses because 80% >= 70%
      await monitor.fetchLiveUsage(false);
      expect(monitor.isRunnerPaused('claude')).toBe(true);

      // 2. Developer manually resumes the runner (sets override)
      monitor.resumeFromQuota('claude', true);
      expect(monitor.isRunnerPaused('claude')).toBe(false);
      expect(monitor.isRunnerOverridden('claude')).toBe(true);

      // 3. Next poll occurs while usage is STILL 80% — should NOT re-pause
      await monitor.fetchLiveUsage(false);
      expect(monitor.isRunnerPaused('claude')).toBe(false);

      // 4. In a new reset window, usage drops and override automatically clears
      const newResetTime = new Date(Date.now() + 5 * 60 * 60 * 1000);
      provider.getCachedLiveUsage = () => ({
        sessionUsedPercentage: 20,
        sessionResetText: 'resets in 5 hours',
        sessionResetAt: newResetTime,
        lastFetchedAt: new Date(),
      });

      await monitor.fetchLiveUsage(false);
      expect(monitor.isRunnerOverridden('claude')).toBe(false);
      expect(monitor.isRunnerPaused('claude')).toBe(false);
    });

    it('should ignore quota threshold and suppress pause events when runner is not in allowedProviders', async () => {
      const monitor = new QuotaMonitor({
        pauseOnLimit: true,
        utilizationThresholdLimit: 0.7, // 70%
        allowedProviders: ['agy'], // Claude is disabled in this repo
      });

      const pausedEvents: any[] = [];
      monitor.on('quota_paused', (e) => pausedEvents.push(e));

      const claudeProvider = monitor.getProvider('claude') as any;
      const resetTime = new Date(Date.now() + 2 * 60 * 60 * 1000);
      claudeProvider.isAvailable = async () => true;
      claudeProvider.fetchUsage = async () => ({
        runnerName: 'claude',
        displayName: 'Claude Code CLI',
        buckets: [{ name: 'Session 5h', group: 'Claude Models', windowType: 'five_hour', usedPercentage: 90, resetAt: resetTime }],
        lastFetchedAt: new Date(),
      });
      claudeProvider.getCachedLiveUsage = () => ({
        sessionUsedPercentage: 90,
        sessionResetText: 'resets in 2 hours',
        sessionResetAt: resetTime,
        lastFetchedAt: new Date(),
      });

      const agyProvider = monitor.getProvider('agy') as any;
      agyProvider.isAvailable = async () => true;
      agyProvider.fetchUsage = async () => ({
        runnerName: 'agy',
        displayName: 'Antigravity CLI',
        buckets: [{ name: 'Gemini 5h', group: 'Gemini Models', windowType: 'five_hour', usedPercentage: 30, resetAt: resetTime }],
        lastFetchedAt: new Date(),
      });

      await monitor.fetchLiveUsage(false);

      // Claude exceeds 70%, but since it is not allowed in this repo, it must NOT pause or emit events
      expect(monitor.isRunnerPaused('claude')).toBe(false);
      expect(pausedEvents).toHaveLength(0);

      // If Claude tries to trigger a pause directly, it should be ignored
      monitor.triggerQuotaPause(resetTime, 'Session limit reached', 'claude');
      expect(monitor.isRunnerPaused('claude')).toBe(false);
      expect(pausedEvents).toHaveLength(0);
    });
  });
  describe('Stale pause recovery', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('should not stop a runner for a reset window that has already passed', () => {
      const monitor = new QuotaMonitor();
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const pausedEvents: any[] = [];
      monitor.on('quota_paused', (e) => pausedEvents.push(e));
      monitor.registerPid(4509, 'claude');

      monitor.triggerQuotaPause(new Date(Date.now() - 10 * 60 * 1000), 'Session limit', 'claude', [384]);

      expect(kill).not.toHaveBeenCalled();
      expect(pausedEvents).toHaveLength(0);
      expect(monitor.isRunnerPaused('claude')).toBe(false);
      expect(monitor.getStatus().isPaused).toBe(false);
    });

    it('should not report a pause whose reset time has passed', () => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
      const monitor = new QuotaMonitor();
      vi.spyOn(process, 'kill').mockImplementation(() => true);

      monitor.triggerQuotaPause(new Date(Date.now() + 60 * 60 * 1000), 'Session limit', 'claude');
      expect(monitor.getStatus().isPaused).toBe(true);

      // Clock moves past the reset without the scheduled timer ever running
      vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);

      const status = monitor.getStatus();
      expect(status.isPaused).toBe(false);
      expect(status.pausedRunner).toBeUndefined();
    });

    it('should SIGCONT a stopped process whose runner is no longer paused on the next usage poll', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
      const monitor = new QuotaMonitor();
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      for (const name of ['claude', 'agy']) {
        const provider = monitor.getProvider(name) as any;
        provider.isAvailable = async () => false;
        provider.fetchUsage = async () => null;
      }
      monitor.registerPid(4522, 'claude');

      monitor.triggerQuotaPause(new Date(Date.now() + 60 * 60 * 1000), 'Session limit', 'claude');
      expect(kill).toHaveBeenCalledWith(4522, 'SIGSTOP');

      // The scheduled resume never runs: the clock passes the reset with the timer lost
      vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
      await monitor.fetchLiveUsage();

      expect(kill).toHaveBeenCalledWith(4522, 'SIGCONT');
      expect(monitor.isRunnerPaused('claude')).toBe(false);
    });

    it('should schedule the resume even when a quota_paused listener throws', () => {
      vi.useFakeTimers();
      const monitor = new QuotaMonitor();
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      monitor.registerPid(4509, 'claude');
      monitor.on('quota_paused', () => {
        throw new Error('notifier blew up');
      });

      expect(() =>
        monitor.triggerQuotaPause(new Date(Date.now() + 60 * 1000), 'Session limit', 'claude')
      ).toThrow('notifier blew up');
      expect(kill).toHaveBeenCalledWith(4509, 'SIGSTOP');

      vi.advanceTimersByTime(4 * 60 * 1000);

      expect(kill).toHaveBeenCalledWith(4509, 'SIGCONT');
      expect(monitor.isRunnerPaused('claude')).toBe(false);
    });

    it('should read a just-passed reset as the window that rolled, not tomorrow', () => {
      const monitor = new QuotaMonitor();
      const provider = monitor.getProvider('claude') as any;

      const now = new Date();
      now.setHours(19, 52, 0, 0);
      vi.useFakeTimers({ shouldAdvanceTime: false });
      vi.setSystemTime(now);

      const { liveUsage } = provider.parseUsageOutput(
        'Current session: 99% used · resets 7:50pm (Europe/Amsterdam)'
      );

      const ageMs = Date.now() - liveUsage.sessionResetAt!.getTime();
      expect(ageMs).toBe(2 * 60 * 1000);
    });
  });

  describe('Per-runner pause independence', () => {
    it('should not pause or SIGSTOP a healthy runner when another runner hits its threshold', () => {
      const monitor = new QuotaMonitor({ pauseOnLimit: true });

      monitor.triggerQuotaPause(new Date(Date.now() + 4 * 24 * 60 * 60 * 1000), 'AGY weekly quota', 'agy');

      expect(monitor.isRunnerPaused('agy')).toBe(true);
      expect(monitor.isRunnerPaused('claude')).toBe(false);
      expect(monitor.areAllRunnersPaused()).toBe(false);
      expect(monitor.getStatus().isPaused).toBe(true);
      expect(monitor.getStatus().allRunnersPaused).toBe(false);
    });

    it('should keep each runner on its own resume timer', () => {
      const monitor = new QuotaMonitor({ pauseOnLimit: true });
      const timers = (monitor as any).resumeTimers as Map<string, unknown>;

      monitor.triggerQuotaPause(new Date(Date.now() + 60 * 60 * 1000), 'Claude session limit', 'claude');
      const claudeTimer = timers.get('claude');
      expect(claudeTimer).toBeDefined();

      // A later pause on another runner must not cancel the first runner's scheduled resume
      monitor.triggerQuotaPause(new Date(Date.now() + 4 * 24 * 60 * 60 * 1000), 'AGY weekly quota', 'agy');

      expect(timers.get('claude')).toBe(claudeTimer);
      expect(timers.get('agy')).toBeDefined();
      expect(monitor.areAllRunnersPaused()).toBe(true);

      monitor.resumeFromQuota('claude');

      expect(timers.has('claude')).toBe(false);
      expect(timers.get('agy')).toBeDefined();
      expect(monitor.isRunnerPaused('agy')).toBe(true);
      expect(monitor.areAllRunnersPaused()).toBe(false);
    });

    it('should emit quota_resumed for a runner even while another stays paused', () => {
      const monitor = new QuotaMonitor({ pauseOnLimit: true });
      const resumed: (string | undefined)[] = [];
      monitor.on('quota_resumed', ({ runnerName }: { runnerName?: string }) => resumed.push(runnerName));

      monitor.triggerQuotaPause(new Date(Date.now() + 60 * 60 * 1000), 'Claude session limit', 'claude');
      monitor.triggerQuotaPause(new Date(Date.now() + 4 * 24 * 60 * 60 * 1000), 'AGY weekly quota', 'agy');

      monitor.resumeFromQuota('claude');

      expect(resumed).toEqual(['claude']);
      expect(monitor.isRunnerPaused('claude')).toBe(false);
      expect(monitor.isRunnerPaused('agy')).toBe(true);
    });
  });
});
