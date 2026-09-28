import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Bot } from 'grammy';
import { TelegramRemoteProvider } from '../src/remote/telegram.js';
import { TelegramRateLimiter } from '../src/remote/rate_limiter.js';
import { ActivityLogger } from '../src/logger/index.js';

describe('TelegramRemoteProvider', () => {
  const dummyBotInfo = {
    id: 123456789,
    is_bot: true,
    first_name: 'ImagosBot',
    username: 'imagos_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  };

  let bot: Bot;
  let rateLimiter: TelegramRateLimiter;
  let provider: TelegramRemoteProvider;
  let apiCalls: Array<{ method: string; payload: Record<string, any> }>;

  beforeEach(() => {
    apiCalls = [];
    bot = new Bot('123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', {
      botInfo: dummyBotInfo,
    });

    bot.api.config.use(async (_prev, method, payload) => {
      apiCalls.push({ method, payload: payload as Record<string, any> });
      if (method === 'sendMessage') {
        return { ok: true, result: { message_id: 42, chat: { id: payload.chat_id, type: 'private' }, date: Date.now(), text: payload.text } };
      }
      if (method === 'editMessageText') {
        return { ok: true, result: true };
      }
      if (method === 'answerCallbackQuery') {
        return { ok: true, result: true };
      }
      return { ok: true, result: true };
    });

    rateLimiter = new TelegramRateLimiter({ minChatIntervalMs: 0, minGlobalIntervalMs: 0 });
  });

  afterEach(async () => {
    if (provider) {
      await provider.stop();
    }
  });

  describe('Authorization Whitelist Middleware', () => {
    it('allows updates from authorized user IDs', async () => {
      provider = new TelegramRemoteProvider({
        bot,
        rateLimiter,
        allowedUserIds: [111, 222],
        defaultChatId: 111,
      });

      let commandHandled = false;
      provider.onCommand('status', async (_args, userId) => {
        if (userId === 111) {
          commandHandled = true;
        }
      });

      await bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 10,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 111, type: 'private', first_name: 'Owner' },
          from: { id: 111, is_bot: false, first_name: 'Owner' },
          text: '/status',
          entities: [{ type: 'bot_command', offset: 0, length: 7 }],
        },
      });

      expect(commandHandled).toBe(true);
    });

    it('rejects unauthorized user in private chat and sends security notice', async () => {
      provider = new TelegramRemoteProvider({
        bot,
        rateLimiter,
        allowedUserIds: [111],
        defaultChatId: 111,
      });

      let commandHandled = false;
      provider.onCommand('status', async () => {
        commandHandled = true;
      });

      await bot.handleUpdate({
        update_id: 2,
        message: {
          message_id: 20,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 999, type: 'private', first_name: 'Attacker' },
          from: { id: 999, is_bot: false, first_name: 'Attacker' },
          text: '/status',
          entities: [{ type: 'bot_command', offset: 0, length: 7 }],
        },
      });

      expect(commandHandled).toBe(false);
      const sendMsgCall = apiCalls.find((c) => c.method === 'sendMessage' && c.payload.chat_id === 999);
      expect(sendMsgCall).toBeDefined();
      expect(sendMsgCall?.payload.text).toContain('Unauthorized');
    });

    it('silently drops unauthorized updates in group chats without sending message', async () => {
      provider = new TelegramRemoteProvider({
        bot,
        rateLimiter,
        allowedUserIds: [111],
      });

      let commandHandled = false;
      provider.onCommand('status', async () => {
        commandHandled = true;
      });

      await bot.handleUpdate({
        update_id: 3,
        message: {
          message_id: 30,
          date: Math.floor(Date.now() / 1000),
          chat: { id: -100999, type: 'supergroup', title: 'Public Group' },
          from: { id: 999, is_bot: false, first_name: 'Unknown' },
          text: '/status',
          entities: [{ type: 'bot_command', offset: 0, length: 7 }],
        },
      });

      expect(commandHandled).toBe(false);
      const sendMsgCall = apiCalls.find((c) => c.method === 'sendMessage');
      expect(sendMsgCall).toBeUndefined();
    });

    it('allows all users if allowedUserIds is not configured', async () => {
      provider = new TelegramRemoteProvider({
        bot,
        rateLimiter,
        allowedUserIds: undefined,
      });

      let commandHandled = false;
      provider.onCommand('help', async () => {
        commandHandled = true;
      });

      await bot.handleUpdate({
        update_id: 4,
        message: {
          message_id: 40,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 555, type: 'private' },
          from: { id: 555, is_bot: false, first_name: 'Anyone' },
          text: '/help',
          entities: [{ type: 'bot_command', offset: 0, length: 5 }],
        },
      });

      expect(commandHandled).toBe(true);
    });
  });

  describe('Outbound Messaging (sendMessage & editMessage)', () => {
    it('sends message using defaultChatId and Markdown formatting', async () => {
      provider = new TelegramRemoteProvider({
        bot,
        rateLimiter,
        defaultChatId: 12345,
      });

      const res = await provider.sendMessage('Hello *World*');
      expect(res.messageId).toBe(42);
      const sendCall = apiCalls.find((c) => c.method === 'sendMessage');
      expect(sendCall).toBeDefined();
      expect(sendCall?.payload.chat_id).toBe(12345);
      expect(sendCall?.payload.text).toBe('Hello *World*');
      expect(sendCall?.payload.parse_mode).toBe('Markdown');
    });

    it('sends message to explicit chatId and includes inline keyboard actions', async () => {
      provider = new TelegramRemoteProvider({
        bot,
        rateLimiter,
        defaultChatId: 12345,
      });

      await provider.sendMessage('Choose an option:', {
        chatId: 67890,
        actions: [
          [
            { id: 'btn1', label: 'Option 1', payload: 'v1:opt:1' },
            { id: 'btn2', label: 'View PR', payload: 'v1:pr:2', url: 'https://github.com' },
          ],
        ],
      });

      const sendCall = apiCalls.find((c) => c.method === 'sendMessage' && c.payload.chat_id === 67890);
      expect(sendCall).toBeDefined();
      expect(sendCall?.payload.text).toBe('Choose an option:');
      expect(sendCall?.payload.reply_markup).toBeDefined();
    });

    it('throws error when no chatId is provided and no defaultChatId exists', async () => {
      provider = new TelegramRemoteProvider({
        bot,
        rateLimiter,
      });

      await expect(provider.sendMessage('Hello')).rejects.toThrow('No chatId specified');
    });

    it('edits message with updated text and inline keyboard', async () => {
      provider = new TelegramRemoteProvider({
        bot,
        rateLimiter,
        defaultChatId: 12345,
      });

      await provider.editMessage(42, 'Updated message', {
        actions: [[{ id: 'btn', label: 'Done', payload: 'v1:done' }]],
      });

      const editCall = apiCalls.find((c) => c.method === 'editMessageText');
      expect(editCall).toBeDefined();
      expect(editCall?.payload.chat_id).toBe(12345);
      expect(editCall?.payload.message_id).toBe(42);
      expect(editCall?.payload.text).toBe('Updated message');
    });
  });

  describe('Action & Reply Handlers', () => {
    it('dispatches callback query to matching onAction handler, passes ActionContext, and answers callback query', async () => {
      provider = new TelegramRemoteProvider({
        bot,
        rateLimiter,
        allowedUserIds: [111],
      });

      let handledAction: { action: string; payload: string; userId: number; context?: any } | null = null;
      provider.onAction('v1:inf', async (action, payload, userId, context) => {
        handledAction = { action, payload, userId, context };
      });

      await bot.handleUpdate({
        update_id: 5,
        callback_query: {
          id: 'cb-123',
          chat_instance: 'inst-1',
          data: 'v1:inf:42:opt1',
          from: { id: 111, is_bot: false, first_name: 'Owner' },
          message: {
            message_id: 50,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 111, type: 'private' },
            text: 'Question: Which database?',
          },
        },
      });

      expect(handledAction).toEqual({
        action: 'v1:inf',
        payload: 'v1:inf:42:opt1',
        userId: 111,
        context: {
          messageId: 50,
          chatId: 111,
          originalText: 'Question: Which database?',
        },
      });
      const answerCall = apiCalls.find((c) => c.method === 'answerCallbackQuery');
      expect(answerCall).toBeDefined();
      expect(answerCall?.payload.callback_query_id).toBe('cb-123');
    });

    it('dispatches text reply to onTextReply handler', async () => {
      provider = new TelegramRemoteProvider({
        bot,
        rateLimiter,
        allowedUserIds: [111],
      });

      let handledReply: { replyToId: number; text: string; userId: number } | null = null;
      provider.onTextReply((replyToId, text, userId) => {
        handledReply = { replyToId, text, userId };
        return Promise.resolve();
      });

      await bot.handleUpdate({
        update_id: 6,
        message: {
          message_id: 60,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 111, type: 'private' },
          from: { id: 111, is_bot: false, first_name: 'Owner' },
          text: 'Use sqlite3 instead of postgres',
          reply_to_message: {
            message_id: 55,
            date: Math.floor(Date.now() / 1000) - 10,
            chat: { id: 111, type: 'private' },
            text: 'Question: Which database should we use?',
          },
        },
      });

      expect(handledReply).toEqual({
        replyToId: 55,
        text: 'Use sqlite3 instead of postgres',
        userId: 111,
      });
    });

    it('dispatches command with arguments and ActionContext to onCommand handler', async () => {
      provider = new TelegramRemoteProvider({
        bot,
        rateLimiter,
        allowedUserIds: [111],
        defaultChatId: 111,
      });

      let receivedArgs: string[] = [];
      let receivedUserId: number = 0;
      let receivedContext: any = null;

      provider.onCommand('specs', async (args, userId, context) => {
        receivedArgs = args;
        receivedUserId = userId;
        receivedContext = context;
      });

      await bot.handleUpdate({
        update_id: 7,
        message: {
          message_id: 70,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 111, type: 'private' },
          from: { id: 111, is_bot: false, first_name: 'Owner' },
          text: '/specs 22, 25',
          entities: [{ type: 'bot_command', offset: 0, length: 6 }],
        },
      });

      expect(receivedUserId).toBe(111);
      expect(receivedArgs).toEqual(['22,', '25']);
      expect(receivedContext).toEqual({
        chatId: 111,
        messageId: 70,
      });
    });
  });

  describe('Dynamic Command Registration (setMyCommands)', () => {
    it('registers native BOT_COMMANDS with Telegram Bot API', async () => {
      provider = new TelegramRemoteProvider({
        bot,
        rateLimiter,
        botHandle: '@imagos_backend_bot',
        allowedChatIds: [123456789],
        defaultChatId: 123456789,
      });

      await provider.registerCommands();

      const setMyCommandsCall = apiCalls.find((c) => c.method === 'setMyCommands');
      expect(setMyCommandsCall).toBeDefined();
      expect(setMyCommandsCall?.payload.commands).toEqual([
        { command: 'start', description: 'Show command reference and status' },
        { command: 'status', description: 'View active tasks, worktrees & DAG' },
        { command: 'tasks', description: 'List in-progress and queued tasks' },
        { command: 'browse', description: 'Paginated list of open issues' },
        { command: 'steer', description: 'Steer a running session with instructions' },
        { command: 'enqueue', description: 'Queue an issue first: /enqueue <issue> [--now] [--runner <name>] [--force]' },
        { command: 'run', description: 'Alias of /enqueue — same options' },
        { command: 'specs', description: 'List and switch scoped parent specs' },
        { command: 'pause', description: 'Pause all workers or a specific issue' },
        { command: 'resume', description: 'Clear rate-limit pause and resume workers' },
        { command: 'clean', description: 'Clean inactive worktrees and temp branches' },
        { command: 'inspect', description: 'Inspect active worker tool calls & diffs' },
        { command: 'logs', description: 'View recent daemon logs' },
        { command: 'help', description: 'Show command reference and usage' },
      ]);
    });

    it('handles setMyCommands error non-blockingly without throwing', async () => {
      bot.api.config.use(async (_prev, method) => {
        if (method === 'setMyCommands') {
          throw new Error('Telegram network error');
        }
        return { ok: true, result: true };
      });

      provider = new TelegramRemoteProvider({
        bot,
        rateLimiter,
      });

      const warnSpy = vi.spyOn(ActivityLogger, 'warn').mockImplementation(() => {});
      await expect(provider.registerCommands()).resolves.not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to register Telegram bot commands'));
      warnSpy.mockRestore();
    });
  });

  describe('allowedChatIds Whitelist Authorization', () => {
    it('allows incoming updates from whitelisted chat IDs', async () => {
      provider = new TelegramRemoteProvider({
        bot,
        rateLimiter,
        allowedChatIds: [123456789, -1001234567890],
        defaultChatId: 123456789,
      });

      let commandHandled = false;
      provider.onCommand('status', async () => {
        commandHandled = true;
      });

      await bot.handleUpdate({
        update_id: 10,
        message: {
          message_id: 100,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 123456789, type: 'private' },
          from: { id: 999, is_bot: false, first_name: 'AuthorizedChat' },
          text: '/status',
          entities: [{ type: 'bot_command', offset: 0, length: 7 }],
        },
      });

      expect(commandHandled).toBe(true);
    });

    it('drops incoming updates from non-whitelisted group chats silently', async () => {
      provider = new TelegramRemoteProvider({
        bot,
        rateLimiter,
        allowedChatIds: [123456789],
        defaultChatId: 123456789,
      });

      let commandHandled = false;
      provider.onCommand('status', async () => {
        commandHandled = true;
      });

      await bot.handleUpdate({
        update_id: 11,
        message: {
          message_id: 101,
          date: Math.floor(Date.now() / 1000),
          chat: { id: -1009999999999, type: 'supergroup', title: 'Unauthorized Group' },
          from: { id: 999, is_bot: false, first_name: 'User' },
          text: '/status',
          entities: [{ type: 'bot_command', offset: 0, length: 7 }],
        },
      });

      expect(commandHandled).toBe(false);
      // No security notice sent to group
      const sentMsgs = apiCalls.filter((c) => c.method === 'sendMessage');
      expect(sentMsgs).toHaveLength(0);
    });

    it('returns getters for botHandle and allowedChatIds', () => {
      provider = new TelegramRemoteProvider({
        bot,
        rateLimiter,
        botHandle: '@imagos_custom_bot',
        allowedChatIds: [555, 666],
      });

      expect(provider.getBotHandle()).toBe('@imagos_custom_bot');
      expect(provider.getAllowedChatIds()).toEqual([555, 666]);
    });
  });
});
