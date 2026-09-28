import { Bot, InlineKeyboard, type Context, type NextFunction } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import type {
  RemoteControlProvider,
  RemoteMessageOptions,
  TelegramRemoteProviderOptions,
  ActionContext,
} from './types.js';
import { TelegramRateLimiter } from './rate_limiter.js';
import { ActivityLogger } from '../logger/index.js';

export const BOT_COMMANDS = [
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
];

export class TelegramRemoteProvider implements RemoteControlProvider {
  public readonly name = 'telegram';
  private bot: Bot;
  private botHandle?: string;
  private allowedChatIds?: (number | string)[];
  private allowedUserIds?: number[];
  private defaultChatId?: number | string;
  private rateLimiter: TelegramRateLimiter;
  private isRunning: boolean = false;
  private actionHandlers: Map<
    string,
    (action: string, payload: string, userId: number, context?: ActionContext) => Promise<void>
  > = new Map();
  private textReplyHandlers: Array<(replyToMessageId: number, text: string, userId: number) => Promise<void>> = [];
  private commandHandlers: Map<string, (args: string[], userId: number) => Promise<void>> = new Map();

  constructor(options: TelegramRemoteProviderOptions) {
    this.botHandle = options.botHandle;
    this.allowedChatIds = options.allowedChatIds;
    this.allowedUserIds = options.allowedUserIds;
    this.defaultChatId = options.defaultChatId;
    this.rateLimiter = options.rateLimiter ?? new TelegramRateLimiter();

    if (options.bot) {
      this.bot = options.bot;
    } else {
      if (!options.botToken) {
        throw new Error('Telegram bot token is required');
      }
      this.bot = new Bot(options.botToken);
      this.bot.api.config.use(
        autoRetry(options.autoRetryOptions ?? { maxRetryAttempts: 3, maxDelaySeconds: 60 })
      );
    }

    this.setupMiddleware();
  }

  public getBot(): Bot {
    return this.bot;
  }

  public getBotHandle(): string | undefined {
    return this.botHandle;
  }

  public getRateLimiter(): TelegramRateLimiter {
    return this.rateLimiter;
  }

  public getDefaultChatId(): number | string | undefined {
    return this.defaultChatId;
  }

  public getAllowedUserIds(): number[] | undefined {
    return this.allowedUserIds;
  }

  public getAllowedChatIds(): (number | string)[] | undefined {
    return this.allowedChatIds;
  }

  public async registerCommands(): Promise<void> {
    try {
      await this.bot.api.setMyCommands(BOT_COMMANDS);
    } catch (err: any) {
      ActivityLogger.warn(`Warning: Failed to register Telegram bot commands: ${err?.message || err}`);
    }
  }

  private setupMiddleware(): void {
    // 1. Authorization Whitelist Middleware
    this.bot.use(async (ctx: Context, next: NextFunction) => {
      const chatId = ctx.chat?.id;
      const isPrivate = ctx.chat?.type === 'private';

      // 1a. Check allowedChatIds if configured
      if (this.allowedChatIds && this.allowedChatIds.length > 0) {
        const isChatAllowed =
          chatId !== undefined &&
          (this.allowedChatIds.includes(chatId) ||
            this.allowedChatIds.includes(String(chatId)) ||
            this.allowedChatIds.map(String).includes(String(chatId)));

        if (!isChatAllowed) {
          if (isPrivate && ctx.chat?.id) {
            try {
              await this.rateLimiter.enqueue(ctx.chat.id, () =>
                this.bot.api.sendMessage(
                  ctx.chat!.id,
                  `🔒 *Unauthorized*: This chat (\`${chatId ?? 'unknown'}\`) is not authorized to control this Imagos instance.`,
                  { parse_mode: 'Markdown' }
                )
              );
            } catch {
              // Ignore failure to reply to unauthorized chat
            }
          }
          // Silently drop update
          return;
        }
      }

      // 1b. Check allowedUserIds if configured
      if (this.allowedUserIds && this.allowedUserIds.length > 0) {
        const userId = ctx.from?.id;
        const isUserAllowed = userId !== undefined && this.allowedUserIds.includes(userId);

        if (!isUserAllowed) {
          if (isPrivate && ctx.chat?.id) {
            try {
              await this.rateLimiter.enqueue(ctx.chat.id, () =>
                this.bot.api.sendMessage(
                  ctx.chat!.id,
                  `🔒 *Unauthorized*: Your Telegram User ID (\`${userId ?? 'unknown'}\`) is not whitelisted to control this Imagos instance.`,
                  { parse_mode: 'Markdown' }
                )
              );
            } catch {
              // Ignore failure to reply to unauthorized user
            }
          }
          // Silently drop update
          return;
        }
      }

      return next();
    });

    // 2. Callback query handling for interactive actions
    this.bot.on('callback_query:data', async (ctx: Context, next: NextFunction) => {
      const data = ctx.callbackQuery?.data;
      const userId = ctx.from?.id;
      if (!data || userId === undefined) {
        return next();
      }

      const messageId = ctx.callbackQuery?.message?.message_id;
      const chatId = ctx.callbackQuery?.message?.chat?.id ?? ctx.chat?.id;
      const originalText = (ctx.callbackQuery?.message as any)?.text;
      const context: ActionContext = { messageId, chatId, originalText };

      let handled = false;
      for (const [prefix, handler] of this.actionHandlers.entries()) {
        if (data.startsWith(prefix)) {
          handled = true;
          try {
            await ctx.answerCallbackQuery();
          } catch {}
          try {
            await handler(prefix, data, userId, context);
          } catch (err: any) {
            ActivityLogger.error(`Error handling action "${data}":`, err);
          }
          break;
        }
      }

      if (!handled) {
        return next();
      }
    });

    // 3. Text reply handling
    this.bot.on('message:text', async (ctx: Context, next: NextFunction) => {
      const replyTo = ctx.message?.reply_to_message;
      const text = ctx.message?.text;
      const userId = ctx.from?.id;

      if (replyTo && text && userId !== undefined && this.textReplyHandlers.length > 0) {
        for (const handler of this.textReplyHandlers) {
          try {
            await handler(replyTo.message_id, text, userId);
          } catch (err: any) {
            ActivityLogger.error('Error handling text reply:', err);
          }
        }
      }

      return next();
    });
  }


  public onAction(
    actionPrefix: string,
    handler: (action: string, payload: string, userId: number, context?: ActionContext) => Promise<void>
  ): void {
    this.actionHandlers.set(actionPrefix, handler);
  }

  public onTextReply(
    handler: (replyToMessageId: number, text: string, userId: number) => Promise<void>
  ): void {
    this.textReplyHandlers.push(handler);
  }

  public onCommand(
    command: string,
    handler: (args: string[], userId: number, context?: ActionContext) => Promise<void>
  ): void {
    const cleanCommand = command.replace(/^\//, '');
    this.commandHandlers.set(cleanCommand, handler as any);
    this.bot.command(cleanCommand, async (ctx: Context) => {
      const userId = ctx.from?.id;
      if (userId === undefined) return;
      const match = ctx.match;
      const args = typeof match === 'string' && match.trim() ? match.trim().split(/\s+/) : [];
      const chatId = ctx.chat?.id ?? this.defaultChatId;
      const messageId = ctx.message?.message_id;
      const context: ActionContext = { chatId, messageId };
      await handler(args, userId, context);
    });
  }

  public async sendMessage(
    text: string,
    options?: RemoteMessageOptions
  ): Promise<{ messageId: number }> {
    const targetChatId = options?.chatId ?? this.defaultChatId;
    if (targetChatId === undefined) {
      throw new Error('No chatId specified and no defaultChatId configured');
    }

    const parseMode = options?.parseMode ?? 'Markdown';
    const extra: Record<string, any> = {
      parse_mode: parseMode,
    };

    if (options?.replyToMessageId) {
      extra.reply_to_message_id = options.replyToMessageId;
    }

    if (options?.actions && options.actions.length > 0) {
      const keyboard = new InlineKeyboard();
      for (let r = 0; r < options.actions.length; r++) {
        const row = options.actions[r];
        for (const btn of row) {
          if (btn.url) {
            keyboard.url(btn.label, btn.url);
          } else {
            keyboard.text(btn.label, btn.payload);
          }
        }
        if (r < options.actions.length - 1) {
          keyboard.row();
        }
      }
      extra.reply_markup = keyboard;
    }

    try {
      const res = await this.rateLimiter.enqueue(targetChatId, () =>
        this.bot.api.sendMessage(targetChatId, text, extra)
      );
      return { messageId: res.message_id };
    } catch (err: any) {
      if (err?.error_code === 400 && err?.description?.includes('chat not found')) {
        const handleStr = this.botHandle ? ` (${this.botHandle})` : '';
        throw new Error(
          `Chat not found for chatId "${targetChatId}". The user must open the Telegram bot${handleStr} and tap "Start" before the bot can send notifications.`
        );
      }
      if (err?.error_code === 403) {
        const handleStr = this.botHandle ? ` (${this.botHandle})` : '';
        throw new Error(
          `Cannot message user "${targetChatId}" (403 Forbidden). Please open the Telegram bot${handleStr} and tap "Start" to permit messages.`
        );
      }
      throw err;
    }
  }

  public async editMessage(
    messageId: number,
    text: string,
    options?: RemoteMessageOptions
  ): Promise<void> {
    const targetChatId = options?.chatId ?? this.defaultChatId;
    if (targetChatId === undefined) {
      throw new Error('No chatId specified and no defaultChatId configured');
    }

    const parseMode = options?.parseMode ?? 'Markdown';
    const extra: Record<string, any> = {
      parse_mode: parseMode,
    };

    if (options?.actions && options.actions.length > 0) {
      const keyboard = new InlineKeyboard();
      for (let r = 0; r < options.actions.length; r++) {
        const row = options.actions[r];
        for (const btn of row) {
          if (btn.url) {
            keyboard.url(btn.label, btn.url);
          } else {
            keyboard.text(btn.label, btn.payload);
          }
        }
        if (r < options.actions.length - 1) {
          keyboard.row();
        }
      }
      extra.reply_markup = keyboard;
    } else if (options?.actions && options.actions.length === 0) {
      extra.reply_markup = { inline_keyboard: [] };
    }

    try {
      await this.rateLimiter.enqueue(targetChatId, () =>
        this.bot.api.editMessageText(targetChatId, messageId, text, extra)
      );
    } catch (err: any) {
      if (err?.error_code === 400 && err?.description?.includes('chat not found')) {
        const handleStr = this.botHandle ? ` (${this.botHandle})` : '';
        throw new Error(
          `Chat not found for chatId "${targetChatId}". The user must open the Telegram bot${handleStr} and tap "Start" before the bot can send notifications.`
        );
      }
      if (err?.error_code === 403) {
        const handleStr = this.botHandle ? ` (${this.botHandle})` : '';
        throw new Error(
          `Cannot message user "${targetChatId}" (403 Forbidden). Please open the Telegram bot${handleStr} and tap "Start" to permit messages.`
        );
      }
      throw err;
    }
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      await this.registerCommands();
    } catch (err: any) {
      ActivityLogger.warn(`Warning: Failed to register Telegram bot commands: ${err?.message || err}`);
    }

    try {
      this.bot.api.getMe().then((me) => {
        this.botHandle = `@${me.username}`;
        ActivityLogger.info(`Telegram remote control online as @${me.username} (https://t.me/${me.username})`);
      }).catch(() => {});
    } catch {}

    try {
      this.bot
        .start({
          drop_pending_updates: true,
        })
        .catch((err) => {
          if (this.isRunning) {
            ActivityLogger.error('Telegram bot polling error:', err);
          }
        });
    } catch (err: any) {
      this.isRunning = false;
      throw err;
    }
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    try {
      await this.bot.stop();
    } catch {
      // Ignore stop errors if bot was not polling
    }

    this.rateLimiter.destroy();
  }
}
