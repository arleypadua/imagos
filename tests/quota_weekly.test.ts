import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QuotaMonitor, ClaudeUsageProvider, DEFAULT_RESET_BUFFER_MS } from '../src/quota/monitor.js';
import { parseLimitInput, saveQuotaLimits, readQuotaLimits, AutoPilotConfigSchema } from '../src/config/schema.js';

const REAL_USAGE = `You are currently using your subscription to power your Claude Code usage

Current session: 3% used · resets Nov 3 at 10:59pm (Europe/Amsterdam)
Current week (all models): 40% used · resets Nov 9 at 9:59pm (Europe/Amsterdam)
Current week (Fable): 0% used · resets Nov 9 at 10pm (Europe/Amsterdam)
`;

function stubClaude(
  monitor: QuotaMonitor,
  live: {
    session?: number;
    sessionResetAt?: Date;
    week?: number;
    weekResetAt?: Date;
    modelWeeks?: Array<{ model: string; usedPercentage: number; resetAt?: Date }>;
  }
): void {
  const claude = monitor.getProvider('claude') as any;
  claude.fetchUsage = async () => null;
  claude.isAvailable = async () => true;
  claude.getCachedLiveUsage = () => ({
    sessionUsedPercentage: live.session,
    sessionResetAt: live.sessionResetAt,
    sessionResetText: live.sessionResetAt ? 'soon' : undefined,
    weekUsedPercentage: live.week,
    weekResetAt: live.weekResetAt,
    weekResetText: live.weekResetAt ? 'Nov 9 at 9:59pm' : undefined,
    modelWeeks: live.modelWeeks,
    lastFetchedAt: new Date(),
  });
  const agy = monitor.getProvider('agy') as any;
  agy.fetchUsage = async () => null;
  agy.isAvailable = async () => false;
}

describe('Claude /usage weekly window', () => {
  it('reads the weekly reset as a calendar date, not a time today', () => {
    const provider = new ClaudeUsageProvider();
    const { liveUsage, runnerUsage } = provider.parseUsageOutput(REAL_USAGE);

    expect(liveUsage.weekUsedPercentage).toBe(40);
    expect(liveUsage.weekResetAt).toBeDefined();
    const reset = liveUsage.weekResetAt!;
    expect(reset.getMonth()).toBe(10); // November
    expect(reset.getDate()).toBe(9);
    expect(reset.getHours()).toBe(21);
    expect(reset.getMinutes()).toBe(59);

    const weekly = runnerUsage.buckets.find((b) => b.windowType === 'weekly');
    expect(weekly?.resetAt?.getTime()).toBe(reset.getTime());
  });

  it('reads a dated session reset on the day it names', () => {
    const provider = new ClaudeUsageProvider();
    const { liveUsage } = provider.parseUsageOutput(REAL_USAGE);
    expect(liveUsage.sessionResetAt?.getDate()).toBe(3);
    expect(liveUsage.sessionResetAt?.getHours()).toBe(22);
  });
});

// Accounts without a 5h limit: `/usage` prints only the weekly windows.
const USAGE_WITHOUT_SESSION = `You are currently using your subscription to power your Claude Code usage

Current week (all models): 1% used · resets Nov 16 at 10pm (Europe/Amsterdam)
Current week (Fable): 0% used · resets Nov 16 at 10pm (Europe/Amsterdam)

What's contributing to your usage?
Approximate · sessions on this machine only · shares overlap

Last 24h · 695 requests · 8 sessions
  11%  Run fewer sessions at once · up to 5 at once
`;

describe('Claude /usage without a 5h session limit', () => {
  it('leaves the session window out instead of reading it as 0%', () => {
    const { liveUsage, runnerUsage } = new ClaudeUsageProvider().parseUsageOutput(USAGE_WITHOUT_SESSION);

    expect(liveUsage.sessionUsedPercentage).toBeUndefined();
    expect(liveUsage.sessionResetAt).toBeUndefined();
    expect(runnerUsage.buckets.some((b) => b.windowType === 'five_hour')).toBe(false);
    expect(liveUsage.weekUsedPercentage).toBe(1);
    expect(liveUsage.weekResetAt?.getDate()).toBe(16);
  });

  it('reads the Fable weekly window as its own bucket', () => {
    const { liveUsage, runnerUsage } = new ClaudeUsageProvider().parseUsageOutput(USAGE_WITHOUT_SESSION);

    expect(liveUsage.modelWeeks).toHaveLength(1);
    expect(liveUsage.modelWeeks![0]).toMatchObject({ model: 'Fable', usedPercentage: 0 });
    expect(liveUsage.modelWeeks![0].resetAt?.getHours()).toBe(22);
    expect(runnerUsage.buckets.map((b) => b.name)).toEqual(['Weekly', 'Weekly (Fable)']);
  });

  it('keeps the all-models week apart from the Fable week', () => {
    const { liveUsage } = new ClaudeUsageProvider().parseUsageOutput(
      'Current week (Fable): 70% used · resets Nov 16 at 10pm\nCurrent week (all models): 20% used · resets Nov 15 at 9pm'
    );
    expect(liveUsage.weekUsedPercentage).toBe(20);
    expect(liveUsage.modelWeeks?.map((m) => m.usedPercentage)).toEqual([70]);
  });

  it('has no model weeks when the account has none', () => {
    const { liveUsage } = new ClaudeUsageProvider().parseUsageOutput(REAL_USAGE.replace(/^Current week \(Fable\).*$/m, ''));
    expect(liveUsage.modelWeeks).toBeUndefined();
  });

  it('takes a limit message reset from its own line, not the weekly line above it', () => {
    const { liveUsage } = new ClaudeUsageProvider().parseUsageOutput(
      "Current week (all models): 40% used · resets Nov 16 at 10pm\nYou've hit your usage limit · resets 11am"
    );
    expect(liveUsage.sessionUsedPercentage).toBe(100);
    expect(liveUsage.sessionResetText).toBe('11am');
  });
});

describe('QuotaMonitor weekly limit', () => {
  it('defaults the weekly limit to 90%', () => {
    expect(new QuotaMonitor().getThresholds()).toEqual({ fiveHourPercent: 85, weeklyPercent: 90 });
  });

  it('pauses Claude until the weekly reset once the week passes the weekly limit', async () => {
    const monitor = new QuotaMonitor();
    const weekResetAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    stubClaude(monitor, { session: 10, sessionResetAt: new Date(Date.now() + 60 * 60 * 1000), week: 91, weekResetAt });

    await monitor.fetchLiveUsage();

    expect(monitor.isRunnerPaused('claude')).toBe(true);
    const status = monitor.getStatus();
    expect(status.reason).toContain('Weekly');
    expect(status.pausedRunners?.claude.resetAt.getTime()).toBe(weekResetAt.getTime() + DEFAULT_RESET_BUFFER_MS);
  });

  it('pauses on the weekly limit when the 5h session line is missing', async () => {
    const monitor = new QuotaMonitor();
    stubClaude(monitor, { week: 95, weekResetAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });

    await monitor.fetchLiveUsage();

    expect(monitor.isRunnerPaused('claude')).toBe(true);
  });

  it('pauses until the Fable reset once the Fable week passes the weekly limit', async () => {
    const monitor = new QuotaMonitor();
    const fableResetAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    stubClaude(monitor, {
      week: 30,
      weekResetAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      modelWeeks: [{ model: 'Fable', usedPercentage: 92, resetAt: fableResetAt }],
    });

    await monitor.fetchLiveUsage();

    expect(monitor.isRunnerPaused('claude')).toBe(true);
    expect(monitor.getStatus().reason).toContain('Fable');
    expect(monitor.getStatus().pausedRunners?.claude.resetAt.getTime()).toBe(
      fableResetAt.getTime() + DEFAULT_RESET_BUFFER_MS
    );
  });

  it('keeps running while the Fable week is under the weekly limit', async () => {
    const monitor = new QuotaMonitor();
    stubClaude(monitor, { week: 30, modelWeeks: [{ model: 'Fable', usedPercentage: 50 }] });

    await monitor.fetchLiveUsage();

    expect(monitor.isRunnerPaused('claude')).toBe(false);
  });

  it('keeps running below the weekly limit', async () => {
    const monitor = new QuotaMonitor();
    stubClaude(monitor, { session: 10, week: 89, weekResetAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });

    await monitor.fetchLiveUsage();

    expect(monitor.isRunnerPaused('claude')).toBe(false);
  });

  it('waits for the later reset when both windows are over their limits', async () => {
    const monitor = new QuotaMonitor();
    const sessionResetAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const weekResetAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    stubClaude(monitor, { session: 99, sessionResetAt, week: 99, weekResetAt });

    await monitor.fetchLiveUsage();

    expect(monitor.getStatus().pausedRunners?.claude.resetAt.getTime()).toBe(
      weekResetAt.getTime() + DEFAULT_RESET_BUFFER_MS
    );
  });

  it('resumes as soon as a raised weekly limit puts usage back under it', async () => {
    const monitor = new QuotaMonitor();
    stubClaude(monitor, { session: 10, week: 92, weekResetAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });
    await monitor.fetchLiveUsage();
    expect(monitor.isRunnerPaused('claude')).toBe(true);

    monitor.setOptions({ weeklyThresholdLimit: 0.95 });
    await monitor.fetchLiveUsage();

    expect(monitor.isRunnerPaused('claude')).toBe(false);
  });

  it('pauses straight away when the weekly limit is lowered under current usage', async () => {
    const monitor = new QuotaMonitor();
    stubClaude(monitor, { session: 10, week: 60, weekResetAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });
    await monitor.fetchLiveUsage();
    expect(monitor.isRunnerPaused('claude')).toBe(false);

    monitor.setOptions({ weeklyThresholdLimit: 0.5 });
    await monitor.fetchLiveUsage();

    expect(monitor.isRunnerPaused('claude')).toBe(true);
  });

  it('does not lift a rate-limit pause just because usage reads under the limits', async () => {
    const monitor = new QuotaMonitor();
    monitor.triggerQuotaPause(new Date(Date.now() + 60 * 60 * 1000), 'hit your usage limit', 'claude');
    stubClaude(monitor, { session: 10, week: 10 });

    await monitor.fetchLiveUsage();

    expect(monitor.isRunnerPaused('claude')).toBe(true);
  });

  it('holds AGY weekly buckets to the weekly limit and 5h buckets to the 5h limit', async () => {
    const monitor = new QuotaMonitor({ utilizationThresholdLimit: 0.85, weeklyThresholdLimit: 0.9 });
    const claude = monitor.getProvider('claude') as any;
    claude.isAvailable = async () => false;
    const agy = monitor.getProvider('agy') as any;
    agy.isAvailable = async () => true;
    const reset = new Date(Date.now() + 60 * 60 * 1000);
    agy.fetchUsage = async () => ({
      runnerName: 'agy',
      displayName: 'agy',
      lastFetchedAt: new Date(),
      buckets: [
        { name: 'Gemini 5h', group: 'Gemini', windowType: 'five_hour', usedPercentage: 50, resetAt: reset },
        { name: 'Gemini Weekly', group: 'Gemini', windowType: 'weekly', usedPercentage: 87, resetAt: reset },
      ],
    });

    await monitor.fetchLiveUsage(true);
    expect(monitor.isRunnerPaused('agy')).toBe(false);

    monitor.setOptions({ weeklyThresholdLimit: 0.85 });
    await monitor.fetchLiveUsage(true);
    expect(monitor.isRunnerPaused('agy')).toBe(true);
  });
});

describe('usage limit config', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('parses limits typed as percentages or fractions', () => {
    expect(parseLimitInput('90')).toBe(0.9);
    expect(parseLimitInput('90%')).toBe(0.9);
    expect(parseLimitInput('0.9')).toBe(0.9);
    expect(parseLimitInput(85)).toBe(0.85);
    expect(parseLimitInput('100')).toBe(1);
    expect(parseLimitInput('150')).toBeUndefined();
    expect(parseLimitInput('0')).toBeUndefined();
    expect(parseLimitInput('abc')).toBeUndefined();
  });

  it('defaults the weekly limit to 90% when nothing is configured', () => {
    expect(AutoPilotConfigSchema.parse({}).quota.weeklyThresholdLimit).toBe(0.9);
  });

  it('writes limits into the saved config without touching other settings', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagos-limits-'));
    const file = path.join(dir, '.autopilot', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ repository: 'a/b', quota: { pauseOnLimit: true, utilizationThresholdLimit: 0.9, proxyPort: 1234 } })
    );

    saveQuotaLimits({ weekly: 0.8 }, file, dir);
    expect(readQuotaLimits(file, dir)).toEqual({ fiveHour: 0.9, weekly: 0.8 });

    saveQuotaLimits({ fiveHour: 0.7 }, file, dir);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.repository).toBe('a/b');
    expect(saved.quota).toEqual({
      pauseOnLimit: true,
      utilizationThresholdLimit: 0.7,
      weeklyThresholdLimit: 0.8,
      proxyPort: 1234,
    });
  });
});
