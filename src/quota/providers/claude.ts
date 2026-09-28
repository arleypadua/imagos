import { execa } from 'execa';
import { rollForwardIfStale } from '../types.js';
import type { ClaudeLiveUsage, QuotaBucket, RunnerLiveUsage, UsageProvider } from '../types.js';

export class ClaudeUsageProvider implements UsageProvider {
  public readonly name = 'claude';
  public readonly displayName = 'Claude Code CLI';
  private cachedLiveUsage: ClaudeLiveUsage | null = null;
  private cachedRunnerUsage: RunnerLiveUsage | null = null;
  private lastFetchTime = 0;

  private parseResetTimeString(str: string): Date | undefined {
    const lower = str.toLowerCase();

    // 1. Check relative "resets in X hours Y minutes" or "resets in Xh Ym"
    const inHoursMatch =
      lower.match(/resets?\s+(?:in|after)\s+(\d+)\s*h(?:ours?)?(?:\s*(\d+)\s*m(?:inutes?)?)?/i) ||
      lower.match(/(\d+)\s*h(?:ours?)?(?:\s*(\d+)\s*m(?:inutes?)?)?/i);
    if (inHoursMatch) {
      const hours = parseInt(inHoursMatch[1], 10);
      const minutes = inHoursMatch[2] ? parseInt(inHoursMatch[2], 10) : 0;
      const ms = (hours * 60 + minutes) * 60 * 1000;
      if (ms > 0) return new Date(Date.now() + ms);
    }

    // 2. Check relative "resets in X minutes" / "Xm"
    const inMinsMatch =
      lower.match(/resets?\s+(?:in|after)\s+(\d+)\s*m(?:inutes?)?/i) ||
      lower.match(/(\d+)\s*m(?:inutes?)/i);
    if (inMinsMatch) {
      const minutes = parseInt(inMinsMatch[1], 10);
      const ms = minutes * 60 * 1000;
      if (ms > 0) return new Date(Date.now() + ms);
    }

    // 3. Check am/pm time string like "11am", "11:00 am", "5pm (Europe/Amsterdam)"
    const timeMatch = str.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
    if (timeMatch) {
      let hour = parseInt(timeMatch[1], 10);
      const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
      const ampm = timeMatch[3]?.toLowerCase();

      if (ampm === 'pm' && hour < 12) hour += 12;
      if (ampm === 'am' && hour === 12) hour = 0;

      const target = new Date();
      target.setHours(hour, minute, 0, 0);
      return rollForwardIfStale(target);
    }

    // 4. Check 24-hour time string like "17:00"
    const time24Match = str.match(/(?:at\s+)?(\d{1,2}):(\d{2})/i);
    if (time24Match) {
      const hour = parseInt(time24Match[1], 10);
      const minute = parseInt(time24Match[2], 10);
      const target = new Date();
      target.setHours(hour, minute, 0, 0);
      return rollForwardIfStale(target);
    }

    return undefined;
  }

  public parseUsageOutput(stdout: string): { liveUsage: ClaudeLiveUsage; runnerUsage: RunnerLiveUsage } {
    const sessionMatch = stdout.match(/Current session:\s*(\d+)%\s*used(?:\s*·\s*resets\s*([^\n\r]+))?/i);
    const weekMatch = stdout.match(/Current week(?:\s*\(all models\))?:\s*(\d+)%\s*used(?:\s*·\s*resets\s*([^\n\r]+))?/i);

    let sessionUsedPercentage = 0;
    let sessionResetText: string | undefined = undefined;
    let sessionResetAt: Date | undefined = undefined;

    if (sessionMatch) {
      sessionUsedPercentage = parseInt(sessionMatch[1], 10);
      sessionResetText = sessionMatch[2]?.trim();
      if (sessionResetText) {
        sessionResetAt = this.parseResetTimeString(sessionResetText);
      }
    } else {
      // Check if session limit string is present in stdout
      const lower = stdout.toLowerCase();
      const limitPatterns = [
        'session limit',
        'hit your session limit',
        'usage limit reached',
        'rate limit reached',
        '5-hour limit',
        'hit your 5-hour limit',
        'hit your usage limit',
        'quota exceeded',
      ];
      const isLimitHit = limitPatterns.some((pattern) => lower.includes(pattern));
      if (isLimitHit) {
        sessionUsedPercentage = 100;
        const resetMatch = stdout.match(/resets\s+([^\n\r]+)/i);
        if (resetMatch) {
          sessionResetText = resetMatch[1]?.trim();
          sessionResetAt = this.parseResetTimeString(sessionResetText);
        }
        if (!sessionResetAt) {
          sessionResetAt = new Date(Date.now() + 60 * 60 * 1000);
          sessionResetText = 'in 1 hour';
        }
      }
    }

    let weekUsedPercentage: number | undefined = undefined;
    let weekResetText: string | undefined = undefined;
    if (weekMatch) {
      weekUsedPercentage = parseInt(weekMatch[1], 10);
      weekResetText = weekMatch[2]?.trim();
    }

    const now = new Date();
    const liveUsage: ClaudeLiveUsage = {
      sessionUsedPercentage,
      sessionResetText,
      sessionResetAt,
      weekUsedPercentage,
      weekResetText,
      lastFetchedAt: now,
    };

    const buckets: QuotaBucket[] = [
      {
        name: 'Session 5h',
        group: 'Claude Models',
        windowType: 'five_hour',
        usedPercentage: sessionUsedPercentage,
        remainingPercentage: Math.max(0, 100 - sessionUsedPercentage),
        resetAt: sessionResetAt,
        resetText: sessionResetText,
      },
    ];

    if (weekUsedPercentage !== undefined) {
      buckets.push({
        name: 'Weekly',
        group: 'Claude Models',
        windowType: 'weekly',
        usedPercentage: weekUsedPercentage,
        remainingPercentage: Math.max(0, 100 - weekUsedPercentage),
        resetText: weekResetText,
      });
    }

    const runnerUsage: RunnerLiveUsage = {
      runnerName: this.name,
      displayName: this.displayName,
      buckets,
      lastFetchedAt: now,
      rawText: stdout,
    };

    return { liveUsage, runnerUsage };
  }

  public async isAvailable(): Promise<boolean> {
    try {
      const isWindows = process.platform === 'win32';
      const cmd = isWindows ? 'where' : 'which';
      const { exitCode } = await execa(cmd, ['claude'], { reject: false });
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  public async fetchUsage(forceRefresh = false): Promise<RunnerLiveUsage | null> {
    const now = Date.now();
    if (!forceRefresh && this.cachedRunnerUsage && now - this.lastFetchTime < 60 * 1000) {
      return this.cachedRunnerUsage;
    }

    const available = await this.isAvailable();
    if (!available) {
      return null;
    }

    try {
      const { stdout } = await execa('claude', ['-p', '/usage'], {
        stdin: 'ignore',
        timeout: 10000,
        env: {
          ...process.env,
          CI: 'true',
        },
      });

      const { liveUsage, runnerUsage } = this.parseUsageOutput(stdout);
      this.cachedLiveUsage = liveUsage;
      this.cachedRunnerUsage = runnerUsage;
      this.lastFetchTime = now;
      return runnerUsage;
    } catch {
      return this.cachedRunnerUsage;
    }
  }

  public getCachedLiveUsage(): ClaudeLiveUsage | null {
    return this.cachedLiveUsage;
  }
}
