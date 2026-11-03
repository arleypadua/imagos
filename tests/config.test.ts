import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ZodError } from 'zod';
import {
  AutoPilotConfigSchema,
  RunnerConfigSchema,
  AgyRunnerConfigSchema,
  RemoteControlConfigSchema,
  TelegramRemoteConfigSchema,
  TelegramNotificationsConfigSchema,
  DEFAULT_CONFIG,
  parseSpecsOption,
  loadConfig,
  saveConfig,
  getConfigPath,
  detectRepository,
  ensureGitIgnoreRules,
} from '../src/config/schema.js';

describe('AutoPilotConfigSchema', () => {
  describe('default values', () => {
    it('accepts empty object and applies all default values', () => {
      const config = AutoPilotConfigSchema.parse({});

      expect(config.baseBranch).toBe('main');
      expect(config.maxConcurrency).toBe(2);
      expect(config.maxAutoNudges).toBe(2);
      expect(config.maxRetriesOnFailure).toBe(2);
      expect(config.pollIntervalSeconds).toBe(30);
      expect(config.runner).toBe('claude');
      expect(config.autoMerge).toBe(true);
      expect(config.mergeMethod).toBe('squash');
      expect(config.cleanupWorktreeOnClose).toBe(true);
      expect(config.repository).toBeUndefined();
      expect(config.extraPrompt).toBeUndefined();
      expect(config.runnerConfig).toBeUndefined();

      expect(config.remote).toEqual({
        enabled: false,
        provider: 'telegram',
        telegram: {
          botTokenEnv: 'TELEGRAM_BOT_TOKEN',
          notifications: {
            needsInfo: true,
            quotaPaused: true,
            taskCompleted: true,
            specCompleted: true,
          },
        },
      });

      expect(config.quota).toEqual({
        pauseOnLimit: true,
        utilizationThresholdLimit: 0.85,
        utilizationThreshold: 0.85,
        weeklyThresholdLimit: 0.9,
        tokenCeiling: undefined,
        proxyPort: 9876,
      });

      expect(config.labels).toEqual({
        readyForAgent: 'ready-for-agent',
        needsInfo: 'needs-info',
        readyForHuman: 'ready-for-human',
        needsTriage: 'needs-triage',
        wontfix: 'wontfix',
      });
    });

    it('matches DEFAULT_CONFIG constant', () => {
      const parsed = AutoPilotConfigSchema.parse({});
      expect(DEFAULT_CONFIG).toEqual(parsed);
    });
  });

  describe('valid configurations', () => {
    it('accepts valid custom configuration overriding defaults', () => {
      const custom = {
        repository: 'owner/custom-repo',
        targetSpec: 42,
        baseBranch: 'develop',
        maxConcurrency: 4,
        pollIntervalSeconds: 15,
        extraPrompt: 'Run build before test',
        runner: 'agy' as const,
        customRunnerCommand: 'custom-runner --flags',
        autoMerge: false,
        mergeMethod: 'rebase' as const,
        cleanupWorktreeOnClose: false,
        remote: {
          enabled: true,
          provider: 'telegram' as const,
          telegram: {
            botTokenEnv: 'CUSTOM_TELEGRAM_TOKEN',
            allowedUserIds: [123456789, 987654321],
            defaultChatId: -1001234567890,
            notifications: {
              needsInfo: true,
              quotaPaused: false,
              taskCompleted: true,
              specCompleted: false,
            },
          },
        },
        quota: {
          pauseOnLimit: false,
          utilizationThreshold: 0.9,
          tokenCeiling: 25000,
          proxyPort: 8080,
        },
        labels: {
          readyForAgent: 'agent:ready',
          needsInfo: 'agent:blocked',
          readyForHuman: 'human:review',
          needsTriage: 'triage:needed',
          wontfix: 'abandoned',
        },
      };

      const result = AutoPilotConfigSchema.parse(custom);
      expect(result.repository).toBe('owner/custom-repo');
      expect(result.targetSpec).toBe(42);
      expect(result.baseBranch).toBe('develop');
      expect(result.maxConcurrency).toBe(4);
      expect(result.pollIntervalSeconds).toBe(15);
      expect(result.extraPrompt).toBe('Run build before test');
      expect(result.runner).toBe('agy');
      expect(result.customRunnerCommand).toBe('custom-runner --flags');
      expect(result.autoMerge).toBe(false);
      expect(result.mergeMethod).toBe('rebase');
      expect(result.cleanupWorktreeOnClose).toBe(false);
      expect(result.remote).toEqual(custom.remote);
      expect(result.quota).toEqual({
        pauseOnLimit: false,
        utilizationThresholdLimit: 0.9,
        utilizationThreshold: 0.9,
        weeklyThresholdLimit: 0.9,
        tokenCeiling: 25000,
        proxyPort: 8080,
      });
      expect(result.labels).toEqual(custom.labels);
    });

    it('accepts maxRetriesOnFailure and maxAutoRetries options', () => {
      const config1 = AutoPilotConfigSchema.parse({ maxRetriesOnFailure: 5 });
      expect(config1.maxRetriesOnFailure).toBe(5);

      const config2 = AutoPilotConfigSchema.parse({ maxAutoRetries: 3 });
      expect(config2.maxAutoRetries).toBe(3);
    });

    it('accepts targetSpec as array of integers and targetSpecs', () => {
      const config1 = AutoPilotConfigSchema.parse({ targetSpec: [10, 20, 30] });
      expect(config1.targetSpec).toEqual([10, 20, 30]);

      const config2 = AutoPilotConfigSchema.parse({ targetSpecs: [100, 200] });
      expect(config2.targetSpecs).toEqual([100, 200]);
    });

    it('accepts valid runner choices: claude, agy, pi, custom', () => {
      for (const runner of ['claude', 'agy', 'pi', 'custom'] as const) {
        const config = AutoPilotConfigSchema.parse({ runner });
        expect(config.runner).toBe(runner);
      }
    });

    it('accepts valid mergeMethod choices: squash, merge, rebase', () => {
      for (const mergeMethod of ['squash', 'merge', 'rebase'] as const) {
        const config = AutoPilotConfigSchema.parse({ mergeMethod });
        expect(config.mergeMethod).toBe(mergeMethod);
      }
    });
  });

  describe('runnerConfig and agy settings', () => {
    it('parses optional agy runner settings (model and effort)', () => {
      const config = AutoPilotConfigSchema.parse({
        runner: 'agy',
        runnerConfig: {
          agy: {
            model: 'gemini-3.7-flash',
            effort: 'high',
          },
        },
      });

      expect(config.runnerConfig).toBeDefined();
      expect(config.runnerConfig?.agy?.model).toBe('gemini-3.7-flash');
      expect(config.runnerConfig?.agy?.effort).toBe('high');
    });

    it('parses runnerConfig with only model specified', () => {
      const config = AutoPilotConfigSchema.parse({
        runnerConfig: {
          agy: {
            model: 'claude-3-7-sonnet',
          },
        },
      });

      expect(config.runnerConfig?.agy?.model).toBe('claude-3-7-sonnet');
      expect(config.runnerConfig?.agy?.effort).toBeUndefined();
    });

    it('parses runnerConfig with only effort specified', () => {
      const config = AutoPilotConfigSchema.parse({
        runnerConfig: {
          agy: {
            effort: 'max',
          },
        },
      });

      expect(config.runnerConfig?.agy?.model).toBeUndefined();
      expect(config.runnerConfig?.agy?.effort).toBe('max');
    });

    it('allows empty runnerConfig object', () => {
      const config = AutoPilotConfigSchema.parse({
        runnerConfig: {},
      });

      expect(config.runnerConfig).toEqual({});
    });

    it('allows passthrough properties for additional runner configs', () => {
      const config = AutoPilotConfigSchema.parse({
        runnerConfig: {
          agy: {
            model: 'gemini-2.5-pro',
          },
          claude: {
            thinkingBudget: 4096,
          },
          custom: {
            timeout: 60000,
          },
        },
      });

      expect(config.runnerConfig?.agy?.model).toBe('gemini-2.5-pro');
      expect(config.runnerConfig?.claude).toEqual({ thinkingBudget: 4096 });
      expect(config.runnerConfig?.custom).toEqual({ timeout: 60000 });
    });

    it('AgyRunnerConfigSchema parses standalone agy config', () => {
      const agyConfig = AgyRunnerConfigSchema.parse({
        model: 'gemini-3.7-pro',
        effort: 'medium',
      });
      expect(agyConfig.model).toBe('gemini-3.7-pro');
      expect(agyConfig.effort).toBe('medium');
    });

    it('RunnerConfigSchema parses standalone runnerConfig', () => {
      const parsed = RunnerConfigSchema.parse({
        agy: {
          model: 'gemini-3.7-flash',
          effort: 'low',
        },
      });
      expect(parsed?.agy?.model).toBe('gemini-3.7-flash');
      expect(parsed?.agy?.effort).toBe('low');
    });
  });

  describe('remote configuration', () => {
    it('TelegramNotificationsConfigSchema defaults all notification toggles to true', () => {
      const notifications = TelegramNotificationsConfigSchema.parse({});
      expect(notifications.needsInfo).toBe(true);
      expect(notifications.quotaPaused).toBe(true);
      expect(notifications.taskCompleted).toBe(true);
      expect(notifications.specCompleted).toBe(true);
    });

    it('TelegramNotificationsConfigSchema allows partial overrides', () => {
      const notifications = TelegramNotificationsConfigSchema.parse({
        needsInfo: false,
        specCompleted: false,
      });
      expect(notifications.needsInfo).toBe(false);
      expect(notifications.quotaPaused).toBe(true);
      expect(notifications.taskCompleted).toBe(true);
      expect(notifications.specCompleted).toBe(false);
    });

    it('TelegramRemoteConfigSchema applies default botTokenEnv and notifications', () => {
      const telegram = TelegramRemoteConfigSchema.parse({});
      expect(telegram.botTokenEnv).toBe('TELEGRAM_BOT_TOKEN');
      expect(telegram.allowedUserIds).toBeUndefined();
      expect(telegram.defaultChatId).toBeUndefined();
      expect(telegram.notifications).toEqual({
        needsInfo: true,
        quotaPaused: true,
        taskCompleted: true,
        specCompleted: true,
      });
    });

    it('TelegramRemoteConfigSchema parses allowedUserIds and defaultChatId', () => {
      const telegram = TelegramRemoteConfigSchema.parse({
        botTokenEnv: 'MY_BOT_TOKEN',
        allowedUserIds: [123456789, 987654321],
        defaultChatId: -1001234567890,
      });
      expect(telegram.botTokenEnv).toBe('MY_BOT_TOKEN');
      expect(telegram.allowedUserIds).toEqual([123456789, 987654321]);
      expect(telegram.defaultChatId).toBe(-1001234567890);
    });

    it('TelegramRemoteConfigSchema accepts string defaultChatId', () => {
      const telegram = TelegramRemoteConfigSchema.parse({
        defaultChatId: '@my_channel',
      });
      expect(telegram.defaultChatId).toBe('@my_channel');
    });

    it('TelegramRemoteConfigSchema rejects non-integer allowedUserIds', () => {
      expect(() =>
        TelegramRemoteConfigSchema.parse({ allowedUserIds: [12.34] })
      ).toThrow(ZodError);
    });

    it('RemoteControlConfigSchema applies defaults', () => {
      const remote = RemoteControlConfigSchema.parse({});
      expect(remote.enabled).toBe(false);
      expect(remote.provider).toBe('telegram');
      expect(remote.telegram).toEqual({
        botTokenEnv: 'TELEGRAM_BOT_TOKEN',
        notifications: {
          needsInfo: true,
          quotaPaused: true,
          taskCompleted: true,
          specCompleted: true,
        },
      });
    });

    it('RemoteControlConfigSchema accepts supported providers (telegram, slack, discord)', () => {
      for (const provider of ['telegram', 'slack', 'discord'] as const) {
        const remote = RemoteControlConfigSchema.parse({ provider });
        expect(remote.provider).toBe(provider);
      }
    });

    it('RemoteControlConfigSchema rejects unsupported providers', () => {
      expect(() =>
        RemoteControlConfigSchema.parse({ provider: 'unsupported' })
      ).toThrow(ZodError);
    });

    it('AutoPilotConfigSchema populates defaults when remote is empty or partially specified', () => {
      const config1 = AutoPilotConfigSchema.parse({ remote: {} });
      expect(config1.remote.enabled).toBe(false);
      expect(config1.remote.provider).toBe('telegram');

      const config2 = AutoPilotConfigSchema.parse({
        remote: {
          enabled: true,
          telegram: {
            allowedUserIds: [111, 222],
          },
        },
      });
      expect(config2.remote.enabled).toBe(true);
      expect(config2.remote.provider).toBe('telegram');
      expect(config2.remote.telegram.botTokenEnv).toBe('TELEGRAM_BOT_TOKEN');
      expect(config2.remote.telegram.allowedUserIds).toEqual([111, 222]);
      expect(config2.remote.telegram.notifications.needsInfo).toBe(true);
    });
  });

  describe('repository format validation', () => {
    it('accepts valid repository in owner/repo format', () => {
      const validRepos = [
        'arleypadua/imagos',
        'facebook/react',
        'owner-name/repo-name',
        'org_name/repo.name',
        'user.name/repo_v2',
        '123owner/456repo',
      ];

      for (const repo of validRepos) {
        const config = AutoPilotConfigSchema.parse({ repository: repo });
        expect(config.repository).toBe(repo);
      }
    });

    it('accepts omitted or undefined repository', () => {
      const config1 = AutoPilotConfigSchema.parse({});
      expect(config1.repository).toBeUndefined();

      const config2 = AutoPilotConfigSchema.parse({ repository: undefined });
      expect(config2.repository).toBeUndefined();
    });

    it('rejects invalid repository format without slash', () => {
      expect(() => AutoPilotConfigSchema.parse({ repository: 'invalid-repo' })).toThrow(ZodError);

      try {
        AutoPilotConfigSchema.parse({ repository: 'invalid-repo' });
      } catch (err: any) {
        expect(err).toBeInstanceOf(ZodError);
        expect(err.errors[0].message).toContain('owner/repo');
      }
    });

    it('rejects repository with multiple slashes', () => {
      expect(() => AutoPilotConfigSchema.parse({ repository: 'owner/repo/extra' })).toThrow(ZodError);
    });

    it('rejects empty string as repository', () => {
      expect(() => AutoPilotConfigSchema.parse({ repository: '' })).toThrow(ZodError);
    });

    it('rejects repository with leading or trailing slash', () => {
      expect(() => AutoPilotConfigSchema.parse({ repository: '/repo' })).toThrow(ZodError);
      expect(() => AutoPilotConfigSchema.parse({ repository: 'owner/' })).toThrow(ZodError);
    });

    it('rejects repository with spaces or whitespace', () => {
      expect(() => AutoPilotConfigSchema.parse({ repository: 'owner / repo' })).toThrow(ZodError);
      expect(() => AutoPilotConfigSchema.parse({ repository: ' owner/repo' })).toThrow(ZodError);
      expect(() => AutoPilotConfigSchema.parse({ repository: 'owner/repo ' })).toThrow(ZodError);
    });

    it('rejects non-string repository types', () => {
      expect(() => AutoPilotConfigSchema.parse({ repository: 12345 })).toThrow(ZodError);
      expect(() => AutoPilotConfigSchema.parse({ repository: true })).toThrow(ZodError);
      expect(() => AutoPilotConfigSchema.parse({ repository: {} })).toThrow(ZodError);
    });
  });

  describe('schema validation constraints', () => {
    it('rejects maxConcurrency less than 1', () => {
      expect(() => AutoPilotConfigSchema.parse({ maxConcurrency: 0 })).toThrow(ZodError);
      expect(() => AutoPilotConfigSchema.parse({ maxConcurrency: -1 })).toThrow(ZodError);
    });

    it('rejects pollIntervalSeconds less than 5', () => {
      expect(() => AutoPilotConfigSchema.parse({ pollIntervalSeconds: 4 })).toThrow(ZodError);
      expect(() => AutoPilotConfigSchema.parse({ pollIntervalSeconds: 0 })).toThrow(ZodError);
    });

    it('rejects invalid runner value', () => {
      expect(() => AutoPilotConfigSchema.parse({ runner: 'unsupported-runner' })).toThrow(ZodError);
    });

    it('rejects invalid mergeMethod value', () => {
      expect(() => AutoPilotConfigSchema.parse({ mergeMethod: 'invalid-merge' })).toThrow(ZodError);
    });

    it('rejects quota utilizationThreshold and utilizationThresholdLimit outside [0.01, 1.0]', () => {
      expect(() =>
        AutoPilotConfigSchema.parse({ quota: { utilizationThresholdLimit: 0.005 } })
      ).toThrow(ZodError);
      expect(() =>
        AutoPilotConfigSchema.parse({ quota: { utilizationThresholdLimit: 1.5 } })
      ).toThrow(ZodError);
      expect(() =>
        AutoPilotConfigSchema.parse({ quota: { utilizationThreshold: 0.005 } })
      ).toThrow(ZodError);
      expect(() =>
        AutoPilotConfigSchema.parse({ quota: { utilizationThreshold: 1.5 } })
      ).toThrow(ZodError);
    });

    it('rejects quota tokenCeiling less than 10000', () => {
      expect(() =>
        AutoPilotConfigSchema.parse({ quota: { tokenCeiling: 9999 } })
      ).toThrow(ZodError);
    });
  });
});

describe('parseSpecsOption', () => {
  it('correctly parses a single numeric spec string', () => {
    const result = parseSpecsOption('50');
    expect(result).toEqual([50]);
  });

  it('correctly parses comma-separated spec numbers', () => {
    const result = parseSpecsOption('50,51,52');
    expect(result).toEqual([50, 51, 52]);
  });

  it('trims whitespace around comma-separated tokens', () => {
    const result = parseSpecsOption('  50 ,  51  , 52  ');
    expect(result).toEqual([50, 51, 52]);
  });

  it('correctly parses an array of spec strings', () => {
    const result = parseSpecsOption(['50', '51', '52']);
    expect(result).toEqual([50, 51, 52]);
  });

  it('correctly parses an array containing comma-separated strings', () => {
    const result = parseSpecsOption(['50,51', '52,53']);
    expect(result).toEqual([50, 51, 52, 53]);
  });

  it('appends to previous accumulator array without mutating original', () => {
    const previous = [10, 20];
    const result = parseSpecsOption('30,40', previous);
    expect(result).toEqual([10, 20, 30, 40]);
    expect(previous).toEqual([10, 20]);
  });

  it('deduplicates numbers within input and across previous array', () => {
    const result = parseSpecsOption('50,51,50,52', [51, 53]);
    expect(result).toEqual([51, 53, 50, 52]);
  });

  it('ignores non-numeric or invalid tokens gracefully', () => {
    const result = parseSpecsOption('50,abc,,51,NaN,52');
    expect(result).toEqual([50, 51, 52]);
  });

  it('handles empty string or empty array gracefully', () => {
    expect(parseSpecsOption('')).toEqual([]);
    expect(parseSpecsOption([])).toEqual([]);
    expect(parseSpecsOption('', [10])).toEqual([10]);
  });
});

describe('Configuration file helpers', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagos-config-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getConfigPath', () => {
    it('returns .autopilot/config.json if it exists', () => {
      const autopilotDir = path.join(tmpDir, '.autopilot');
      fs.mkdirSync(autopilotDir, { recursive: true });
      const configPath = path.join(autopilotDir, 'config.json');
      fs.writeFileSync(configPath, '{}', 'utf8');

      expect(getConfigPath(tmpDir)).toBe(configPath);
    });

    it('returns autopilot.config.json if legacy file exists', () => {
      const legacyPath = path.join(tmpDir, 'autopilot.config.json');
      fs.writeFileSync(legacyPath, '{}', 'utf8');

      expect(getConfigPath(tmpDir)).toBe(legacyPath);
    });

    it('defaults to .autopilot/config.json destination if neither exists', () => {
      expect(getConfigPath(tmpDir)).toBe(path.join(tmpDir, '.autopilot', 'config.json'));
    });
  });

  describe('saveConfig and loadConfig', () => {
    it('saves config to disk and loads it back accurately', async () => {
      const configData = {
        repository: 'owner/saved-repo',
        maxConcurrency: 3,
        baseBranch: 'main',
        runner: 'agy' as const,
        runnerConfig: {
          agy: {
            model: 'gemini-3.7-flash',
            effort: 'high',
          },
        },
      };

      const savedPath = saveConfig(configData, undefined, tmpDir);
      expect(fs.existsSync(savedPath)).toBe(true);

      const loaded = await loadConfig(undefined, tmpDir);
      expect(loaded.repository).toBe('owner/saved-repo');
      expect(loaded.maxConcurrency).toBe(3);
      expect(loaded.runner).toBe('agy');
      expect(loaded.runnerConfig?.agy?.model).toBe('gemini-3.7-flash');
      expect(loaded.runnerConfig?.agy?.effort).toBe('high');
      expect(loaded.baseBranch).toBe('main');
    });

    it('saves and loads allowedProviders and allowedRunners array', async () => {
      const configData = {
        repository: 'owner/allowed-providers-repo',
        allowedProviders: ['claude', 'agy'],
        runner: 'claude' as const,
      };

      const savedPath = saveConfig(configData, undefined, tmpDir);
      expect(fs.existsSync(savedPath)).toBe(true);

      const loaded = await loadConfig(undefined, tmpDir);
      expect(loaded.repository).toBe('owner/allowed-providers-repo');
      expect(loaded.allowedProviders).toEqual(['claude', 'agy']);
    });

    it('loads config from custom file path', async () => {
      const customFile = path.join(tmpDir, 'custom.config.json');
      fs.writeFileSync(
        customFile,
        JSON.stringify({ repository: 'custom-org/custom-repo', maxConcurrency: 5 }),
        'utf8'
      );

      const loaded = await loadConfig('custom.config.json', tmpDir);
      expect(loaded.repository).toBe('custom-org/custom-repo');
      expect(loaded.maxConcurrency).toBe(5);
    });

    it('throws descriptive error on invalid JSON file', async () => {
      const invalidFile = path.join(tmpDir, '.autopilot', 'config.json');
      fs.mkdirSync(path.dirname(invalidFile), { recursive: true });
      fs.writeFileSync(invalidFile, '{ not valid json }', 'utf8');

      await expect(loadConfig(undefined, tmpDir)).rejects.toThrow(/Failed to parse configuration file/);
    });
  });

  describe('ensureGitIgnoreRules', () => {
    it('creates .gitignore with .autopilot rule if .gitignore does not exist', () => {
      ensureGitIgnoreRules(tmpDir);
      const gitignorePath = path.join(tmpDir, '.gitignore');
      expect(fs.existsSync(gitignorePath)).toBe(true);

      const content = fs.readFileSync(gitignorePath, 'utf8');
      expect(content).toContain('.autopilot/*');
      expect(content).toContain('!.autopilot/config.json');
    });

    it('appends rule to existing .gitignore if not present', () => {
      const gitignorePath = path.join(tmpDir, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules\ndist\n', 'utf8');

      ensureGitIgnoreRules(tmpDir);
      const content = fs.readFileSync(gitignorePath, 'utf8');
      expect(content).toContain('node_modules');
      expect(content).toContain('.autopilot/*');
    });

    it('does not duplicate rule if already present in .gitignore', () => {
      const gitignorePath = path.join(tmpDir, '.gitignore');
      fs.writeFileSync(gitignorePath, '# custom\n.autopilot/*\n!.autopilot/config.json\n', 'utf8');

      ensureGitIgnoreRules(tmpDir);
      const content = fs.readFileSync(gitignorePath, 'utf8');
      const occurrences = (content.match(/\.autopilot\/\*/g) || []).length;
      expect(occurrences).toBe(1);
    });
  });

  describe('TelegramRepoConfigSchema & telegram.bot support', () => {
    it('parses repo config with top-level telegram object and bot handle', () => {
      const config = AutoPilotConfigSchema.parse({
        telegram: {
          enabled: true,
          bot: '@imagos_backend_bot',
        },
      });

      expect(config.telegram).toBeDefined();
      expect(config.telegram?.enabled).toBe(true);
      expect(config.telegram?.bot).toBe('@imagos_backend_bot');
    });

    it('loadConfig syncs top-level telegram config into remote.telegram', async () => {
      const configFile = path.join(tmpDir, '.autopilot', 'config.json');
      fs.mkdirSync(path.dirname(configFile), { recursive: true });
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          repository: 'owner/repo',
          telegram: {
            enabled: true,
            bot: '@imagos_backend_bot',
          },
        }),
        'utf8'
      );

      const loaded = await loadConfig(undefined, tmpDir);
      expect(loaded.telegram?.enabled).toBe(true);
      expect(loaded.telegram?.bot).toBe('@imagos_backend_bot');
      expect(loaded.remote.enabled).toBe(true);
      expect(loaded.remote.telegram.bot).toBe('@imagos_backend_bot');
    });
  });
});
