import { execa } from 'execa';
import { rollForwardIfStale } from '../types.js';
import type { ClaudeLiveUsage, ClaudeModelWeek, QuotaBucket, RunnerLiveUsage, UsageProvider } from '../types.js';

export class ClaudeUsageProvider implements UsageProvider {
  public readonly name = 'claude';
  public readonly displayName = 'Claude Code CLI';
  private cachedLiveUsage: ClaudeLiveUsage | null = null;
  private cachedRunnerUsage: RunnerLiveUsage | null = null;
  private lastFetchTime = 0;

  // "Nov 9 at 9:59pm (Europe/Amsterdam)", "Nov 9, 10pm", "Aug 26": a reset with a calendar date, as the
  // weekly window reports it. Without the date the time alone reads as today, a week early.
  private parseDatedResetString(str: string): Date | undefined {
    const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const match = str.match(
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:(?:,|\s)+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i
    );
    if (!match) return undefined;

    const month = MONTHS.indexOf(match[1].toLowerCase());
    const day = parseInt(match[2], 10);
    let hour = match[3] ? parseInt(match[3], 10) : 0;
    const minute = match[4] ? parseInt(match[4], 10) : 0;
    const ampm = match[5]?.toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    const now = new Date();
    const target = new Date(now.getFullYear(), month, day, hour, minute, 0, 0);
    // "Jan 2" read in late December names next year's date.
    if (now.getTime() - target.getTime() > 30 * 24 * 60 * 60 * 1000) {
      target.setFullYear(target.getFullYear() + 1);
    }
    return target;
  }

  private parseResetTimeString(str: string): Date | undefined {
    const lower = str.toLowerCase();

    const dated = this.parseDatedResetString(str);
    if (dated) return dated;

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

    // The 5h session line is gone on accounts without a session limit, so it stays undefined rather than
    // reading as 0% of a limit that does not exist.
    let sessionUsedPercentage: number | undefined = undefined;
    let sessionResetText: string | undefined = undefined;
    let sessionResetAt: Date | undefined = undefined;

    if (sessionMatch) {
      sessionUsedPercentage = parseInt(sessionMatch[1], 10);
      sessionResetText = sessionMatch[2]?.trim();
      if (sessionResetText) {
        sessionResetAt = this.parseResetTimeString(sessionResetText);
      }
    } else {
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
      // The reset belongs to the line that reports the limit, not to a weekly line printed beside it.
      const limitLine = stdout
        .split(/\r?\n/)
        .find((line) => limitPatterns.some((pattern) => line.toLowerCase().includes(pattern)));
      if (limitLine !== undefined) {
        sessionUsedPercentage = 100;
        const resetMatch = limitLine.match(/resets\s+(.+)/i);
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
    let weekResetAt: Date | undefined = undefined;
    if (weekMatch) {
      weekUsedPercentage = parseInt(weekMatch[1], 10);
      weekResetText = weekMatch[2]?.trim();
      if (weekResetText) {
        weekResetAt = this.parseResetTimeString(weekResetText);
      }
    }

    // Weekly caps on a single model, such as `Current week (Fable)`, printed only for accounts that have them.
    const modelWeeks: ClaudeModelWeek[] = [];
    for (const m of stdout.matchAll(/Current week\s*\(([^)]+)\):\s*(\d+)%\s*used(?:\s*·\s*resets\s*([^\n\r]+))?/gi)) {
      const model = m[1].trim();
      if (model.toLowerCase() === 'all models') continue;
      const resetText = m[3]?.trim();
      modelWeeks.push({
        model,
        usedPercentage: parseInt(m[2], 10),
        resetText,
        resetAt: resetText ? this.parseResetTimeString(resetText) : undefined,
      });
    }

    const now = new Date();
    const liveUsage: ClaudeLiveUsage = {
      sessionUsedPercentage,
      sessionResetText,
      sessionResetAt,
      weekUsedPercentage,
      weekResetText,
      weekResetAt,
      modelWeeks: modelWeeks.length > 0 ? modelWeeks : undefined,
      lastFetchedAt: now,
    };

    const buckets: QuotaBucket[] = [];

    if (sessionUsedPercentage !== undefined) {
      buckets.push({
        name: 'Session 5h',
        group: 'Claude Models',
        windowType: 'five_hour',
        usedPercentage: sessionUsedPercentage,
        remainingPercentage: Math.max(0, 100 - sessionUsedPercentage),
        resetAt: sessionResetAt,
        resetText: sessionResetText,
      });
    }

    if (weekUsedPercentage !== undefined) {
      buckets.push({
        name: 'Weekly',
        group: 'Claude Models',
        windowType: 'weekly',
        usedPercentage: weekUsedPercentage,
        remainingPercentage: Math.max(0, 100 - weekUsedPercentage),
        resetAt: weekResetAt,
        resetText: weekResetText,
      });
    }

    for (const mw of modelWeeks) {
      buckets.push({
        name: `Weekly (${mw.model})`,
        group: 'Claude Models',
        windowType: 'weekly',
        usedPercentage: mw.usedPercentage,
        remainingPercentage: Math.max(0, 100 - mw.usedPercentage),
        resetAt: mw.resetAt,
        resetText: mw.resetText,
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
