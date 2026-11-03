import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Orchestrator } from '../src/pipeline/orchestrator.js';
import { DEFAULT_CONFIG } from '../src/config/schema.js';
import type { AutoPilotConfig } from '../src/types/index.js';

describe('Orchestrator usage limits', () => {
  let tmpDir: string;
  let configPath: string;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagos-limits-orch-'));
    configPath = path.join(tmpDir, '.autopilot', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ repository: 'owner/repo', runner: 'claude' }, null, 2));
    const config: AutoPilotConfig = { ...DEFAULT_CONFIG, repository: 'owner/repo' };
    orchestrator = new Orchestrator(config, { configPath });
    // No /usage or GitHub calls from a unit test
    vi.spyOn(orchestrator.getQuotaMonitor(), 'fetchLiveUsage').mockResolvedValue(null);
    vi.spyOn(orchestrator, 'tick').mockResolvedValue();
  });

  afterEach(() => {
    (orchestrator as any).configWatcher?.();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports the default limits: 85% of the 5h window and 90% of the week', () => {
    const limits = orchestrator.getQuotaLimits();
    expect(limits.fiveHourPercent).toBe(85);
    expect(limits.weeklyPercent).toBe(90);
  });

  it('applies new limits to the running monitor and writes them to the saved config', async () => {
    const result = await orchestrator.updateQuotaLimits({ weeklyPercent: 75, fiveHourPercent: 60 });

    expect(result.limits.weeklyPercent).toBe(75);
    expect(orchestrator.getQuotaMonitor().getThresholds()).toEqual({ fiveHourPercent: 60, weeklyPercent: 75 });
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(saved.runner).toBe('claude');
    expect(saved.quota).toEqual({ utilizationThresholdLimit: 0.6, weeklyThresholdLimit: 0.75 });
    // The shared defaults are left alone
    expect(DEFAULT_CONFIG.quota.weeklyThresholdLimit).toBe(0.9);
  });

  it('picks up limits written to the config file while running', async () => {
    (orchestrator as any).watchConfigForLimitChanges();
    await new Promise((r) => setTimeout(r, 50));

    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    raw.quota = { weeklyThresholdLimit: 0.7 };
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));

    await vi.waitFor(
      () => expect(orchestrator.getQuotaMonitor().getThresholds().weeklyPercent).toBe(70),
      { timeout: 6000, interval: 100 }
    );
  }, 10000);
});
