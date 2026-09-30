import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockQuestionAnswers, mockCloseFn, mockCreateInterface } = vi.hoisted(() => {
  const answers: string[] = [];
  const close = vi.fn();
  const createInterface = vi.fn().mockImplementation(() => ({
    question: vi.fn().mockImplementation(async () => answers.shift() || ''),
    close,
  }));
  return { mockQuestionAnswers: answers, mockCloseFn: close, mockCreateInterface: createInterface };
});

vi.mock('node:readline/promises', () => ({
  createInterface: mockCreateInterface,
  default: { createInterface: mockCreateInterface },
}));

vi.mock('readline/promises', () => ({
  createInterface: mockCreateInterface,
  default: { createInterface: mockCreateInterface },
}));

vi.mock('../src/config/schema.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/schema.js')>();
  return {
    ...actual,
    saveConfig: vi.fn().mockReturnValue('/mock/path/.autopilot/config.json'),
    detectRepository: vi.fn().mockResolvedValue('arleypadua/imagos'),
  };
});

vi.mock('../src/config/credentials.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/credentials.js')>();
  return {
    ...actual,
    saveTelegramCredentials: vi.fn().mockReturnValue('/mock/home/.imagos/credentials.json'),
    saveTelegramBot: vi.fn().mockReturnValue('/mock/home/.imagos/config.json'),
  };
});

vi.mock('../src/runners/base.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runners/base.js')>();
  return {
    ...actual,
    isBinaryAvailable: vi.fn().mockImplementation(async (bin: string) => {
      return bin === 'claude' || bin === 'agy';
    }),
  };
});

import { program } from '../src/cli.js';
import * as schemaModule from '../src/config/schema.js';
import * as credentialsModule from '../src/config/credentials.js';
import * as baseRunnerModule from '../src/runners/base.js';

function resetCommanderState() {
  program.commands.forEach((c: any) => {
    c._optionValues = {};
    c._optionValueSources = {};
  });
  (program as any)._optionValues = {};
  (program as any)._optionValueSources = {};
}

describe('imagos init CLI command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuestionAnswers.length = 0;
    resetCommanderState();
    vi.mocked(schemaModule.saveConfig).mockReturnValue('/mock/path/.autopilot/config.json');
    vi.mocked(credentialsModule.saveTelegramCredentials).mockReturnValue('/mock/home/.imagos/credentials.json');
    vi.mocked(baseRunnerModule.isBinaryAvailable).mockResolvedValue(true);
    delete (process.stdin as any).isTTY;
  });

  afterEach(() => {
    delete (process.stdin as any).isTTY;
  });

  describe('Non-interactive flags (--remote / --no-remote / --bot-token / --user-id)', () => {
    it('initializes config with remote enabled and saves credentials when --remote, --bot-token and --user-id are passed', async () => {
      await program.parseAsync([
        'node',
        'imagos',
        'init',
        '--repo',
        'owner/my-repo',
        '--runner',
        'agy',
        '--remote',
        '--bot-token',
        '123456:BOT-TOKEN',
        '--user-id',
        '987654321',
      ]);

      expect(credentialsModule.saveTelegramCredentials).toHaveBeenCalledWith({
        repository: 'owner/my-repo',
        botToken: '123456:BOT-TOKEN',
        allowedUserIds: [987654321],
      });

      expect(schemaModule.saveConfig).toHaveBeenCalled();
      const savedConfig = vi.mocked(schemaModule.saveConfig).mock.calls[0][0];
      expect(savedConfig.repository).toBe('owner/my-repo');
      expect(savedConfig.runner).toBe('agy');
      expect(savedConfig.remote.enabled).toBe(true);
      expect(savedConfig.remote.provider).toBe('telegram');
      expect(savedConfig.remote.telegram.allowedUserIds).toEqual([987654321]);
    });

    it('initializes config with remote disabled when --no-remote is passed', async () => {
      await program.parseAsync([
        'node',
        'imagos',
        'init',
        '--repo',
        'owner/my-repo',
        '--runner',
        'claude',
        '--no-remote',
      ]);

      expect(credentialsModule.saveTelegramCredentials).not.toHaveBeenCalled();
      expect(schemaModule.saveConfig).toHaveBeenCalled();
      const savedConfig = vi.mocked(schemaModule.saveConfig).mock.calls[0][0];
      expect(savedConfig.runner).toBe('claude');
      expect(savedConfig.remote.enabled).toBe(false);
    });

    it('defaults remote to false when no remote options are passed in non-interactive environment', async () => {
      (process.stdin as any).isTTY = false;

      await program.parseAsync([
        'node',
        'imagos',
        'init',
        '--repo',
        'owner/my-repo',
        '--runner',
        'claude',
      ]);

      expect(schemaModule.saveConfig).toHaveBeenCalled();
      const savedConfig = vi.mocked(schemaModule.saveConfig).mock.calls[0][0];
      expect(savedConfig.remote.enabled).toBe(false);
    });

    it('initializes config with telegram.bot and saves bot credentials when --telegram-bot and --telegram-token are passed', async () => {
      await program.parseAsync([
        'node',
        'imagos',
        'init',
        '--repo',
        'owner/my-repo',
        '--runner',
        'claude',
        '--telegram-bot',
        '@imagos_backend_bot',
        '--telegram-token',
        '123456:BOT-TOKEN',
        '--telegram-chat-ids',
        '123456789,-1001234567890',
      ]);

      expect(credentialsModule.saveTelegramBot).toHaveBeenCalledWith('@imagos_backend_bot', {
        token: '123456:BOT-TOKEN',
        allowedChatIds: [123456789, -1001234567890],
      });

      expect(schemaModule.saveConfig).toHaveBeenCalled();
      const savedConfig = vi.mocked(schemaModule.saveConfig).mock.calls[0][0];
      expect(savedConfig.telegram?.enabled).toBe(true);
      expect(savedConfig.telegram?.bot).toBe('@imagos_backend_bot');
      expect(savedConfig.remote.enabled).toBe(true);
    });
  });

  describe('Interactive prompt flow', () => {
    it('prompts user and enables Telegram remote control when user confirms (y)', async () => {
      (process.stdin as any).isTTY = true;

      mockQuestionAnswers.push(
        'y', // Enable Telegram remote control?
        '987654:TELEGRAM-TOKEN', // Enter Telegram Bot Token
        '11223344' // Enter Telegram User ID
      );

      await program.parseAsync([
        'node',
        'imagos',
        'init',
        '--repo',
        'owner/prompt-repo',
        '--runner',
        'claude',
      ]);

      expect(credentialsModule.saveTelegramCredentials).toHaveBeenCalledWith({
        repository: 'owner/prompt-repo',
        botToken: '987654:TELEGRAM-TOKEN',
        allowedUserIds: [11223344],
      });

      expect(schemaModule.saveConfig).toHaveBeenCalled();
      const savedConfig = vi.mocked(schemaModule.saveConfig).mock.calls[0][0];
      expect(savedConfig.remote.enabled).toBe(true);
      expect(savedConfig.remote.telegram.allowedUserIds).toEqual([11223344]);
      expect(mockCloseFn).toHaveBeenCalled();
    });

    it('prompts user and disables Telegram remote control when user declines (n)', async () => {
      (process.stdin as any).isTTY = true;

      mockQuestionAnswers.push(
        'n' // Enable Telegram remote control?
      );

      await program.parseAsync([
        'node',
        'imagos',
        'init',
        '--repo',
        'owner/prompt-repo',
        '--runner',
        'claude',
      ]);

      expect(credentialsModule.saveTelegramCredentials).not.toHaveBeenCalled();

      expect(schemaModule.saveConfig).toHaveBeenCalled();
      const savedConfig = vi.mocked(schemaModule.saveConfig).mock.calls[0][0];
      expect(savedConfig.remote.enabled).toBe(false);
      expect(mockCloseFn).toHaveBeenCalled();
    });

    it('prompts for runner selection when runner is not specified and multiple runners available', async () => {
      (process.stdin as any).isTTY = true;

      mockQuestionAnswers.push(
        '2', // Choose runner: 2 -> agy
        'n' // Enable Telegram remote control? -> n
      );

      await program.parseAsync([
        'node',
        'imagos',
        'init',
        '--repo',
        'owner/prompt-repo',
      ]);

      expect(schemaModule.saveConfig).toHaveBeenCalled();
      const savedConfig = vi.mocked(schemaModule.saveConfig).mock.calls[0][0];
      expect(savedConfig.runner).toBe('agy');
      expect(savedConfig.remote.enabled).toBe(false);
      expect(mockCloseFn).toHaveBeenCalled();
    });
  });

  describe('Issue repository', () => {
    const initArgs = ['node', 'imagos', 'init', '--repo', 'owner/code', '--runner', 'claude', '--no-remote'];

    it('saves --issue-repo when it differs from the code repository', async () => {
      (process.stdin as any).isTTY = false;

      await program.parseAsync([...initArgs, '--issue-repo', 'org/issue-tracker']);

      const savedConfig = vi.mocked(schemaModule.saveConfig).mock.calls[0][0];
      expect(savedConfig.issueRepository).toBe('org/issue-tracker');
    });

    it('omits issueRepository when --issue-repo matches the code repository', async () => {
      (process.stdin as any).isTTY = false;

      await program.parseAsync([...initArgs, '--issue-repo', 'owner/code']);

      const savedConfig = vi.mocked(schemaModule.saveConfig).mock.calls[0][0];
      expect(savedConfig).not.toHaveProperty('issueRepository');
    });

    it('prompts for the issue repository in interactive mode', async () => {
      (process.stdin as any).isTTY = true;
      mockQuestionAnswers.push('org/issue-tracker');

      await program.parseAsync(initArgs);

      const savedConfig = vi.mocked(schemaModule.saveConfig).mock.calls[0][0];
      expect(savedConfig.issueRepository).toBe('org/issue-tracker');
    });

    it('keeps issues in the code repository when the prompt is left empty', async () => {
      (process.stdin as any).isTTY = true;
      mockQuestionAnswers.push('');

      await program.parseAsync(initArgs);

      const savedConfig = vi.mocked(schemaModule.saveConfig).mock.calls[0][0];
      expect(savedConfig).not.toHaveProperty('issueRepository');
    });

    it('rejects an issue repository not in owner/repo format without saving anything', async () => {
      (process.stdin as any).isTTY = true;
      mockQuestionAnswers.push('issue-tracker');
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await program.parseAsync(initArgs);

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('owner/repo'));
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(schemaModule.saveConfig).not.toHaveBeenCalled();
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });
});
