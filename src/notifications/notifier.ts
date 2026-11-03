import { EventEmitter } from 'node:events';
import pc from 'picocolors';
import { ActivityLogger } from '../logger/index.js';
import type {
  TaskStartedNotificationPayload,
  TaskCompletedNotificationPayload,
  SpecCompletedNotificationPayload,
  NeedsInfoNotificationPayload,
  QuotaPausedNotificationPayload,
  QuotaResumedNotificationPayload,
} from '../remote/types.js';

export class Notifier {
  private static emitter = new EventEmitter();
  private static logHandler?: (message: string) => void;
  private static isInteractive: boolean = false;

  public static get events(): EventEmitter {
    return Notifier.emitter;
  }

  public static setLogHandler(handler?: (message: string) => void): void {
    Notifier.logHandler = handler;
    ActivityLogger.setLogHandler(handler);
  }

  public static setInteractive(interactive: boolean): void {
    Notifier.isInteractive = interactive;
  }

  public static on(event: string, listener: (...args: any[]) => void): void {
    Notifier.emitter.on(event, listener);
  }

  public static off(event: string, listener: (...args: any[]) => void): void {
    Notifier.emitter.off(event, listener);
  }

  public static removeAllListeners(event?: string): void {
    Notifier.emitter.removeAllListeners(event);
  }

  private static emitLog(rawMessage: string, formattedCliMessage?: string): void {
    if (Notifier.logHandler) {
      try {
        Notifier.logHandler(rawMessage);
      } catch {}
    } else {
      ActivityLogger.log(rawMessage);
    }
    if (!Notifier.isInteractive && !ActivityLogger.isConsoleIntercepted()) {
      console.log(formattedCliMessage || rawMessage);
    }
  }

  public static notifyTaskStarted(payload: TaskStartedNotificationPayload): void {
    const runnerTag = payload.runnerName ? ` [${payload.runnerName}]` : '';
    const action = payload.isContinuation ? 'Resumed' : 'Started';
    const raw = `🤖 [Task ${action}] Issue #${payload.issueNumber}: ${payload.issueTitle}${runnerTag}`;
    Notifier.emitLog(raw, pc.cyan(`\n${raw}`));
    Notifier.emitter.emit('task_started', payload);
  }

  public static notifyTaskNeedsFeedback(
    issueNumber: number,
    issueTitle: string,
    question?: string,
    prUrl?: string,
    prNumber?: number,
    issueUrl?: string,
    choices?: string[]
  ): void {
    const raw = `🔔 [Human Feedback Required] Issue #${issueNumber}: ${issueTitle}${question ? ` (Question: ${question})` : ''}`;
    const cliMsg = question
      ? `${pc.yellow(`\n🔔 [Human Feedback Required] Issue #${issueNumber}: ${issueTitle}`)}\n${pc.yellow(`   Question: ${question}`)}`
      : pc.yellow(`\n🔔 [Human Feedback Required] Issue #${issueNumber}: ${issueTitle}`);
    Notifier.emitLog(raw, cliMsg);
    const payload: NeedsInfoNotificationPayload = {
      issueNumber,
      issueTitle,
      question,
      prUrl,
      prNumber,
      issueUrl,
      choices,
    };
    Notifier.emitter.emit('needs_info', payload);
  }

  public static notifyNeedsFeedback(
    issueNumber: number,
    issueTitle: string,
    question?: string,
    prUrl?: string,
    prNumber?: number,
    issueUrl?: string,
    choices?: string[]
  ): void {
    this.notifyTaskNeedsFeedback(issueNumber, issueTitle, question, prUrl, prNumber, issueUrl, choices);
  }

  public static notifySpecComplete(specNumber: number, specTitle: string): void {
    const raw = `🎉 [Spec Complete] Spec #${specNumber}: ${specTitle} — Waiting for developer review & closure.`;
    Notifier.emitLog(raw, pc.magenta(`\n${raw}`));
    const payload: SpecCompletedNotificationPayload = { specNumber, specTitle };
    Notifier.emitter.emit('spec_completed', payload);
  }

  public static notifyQuotaPaused(
    resetAt: Date,
    waitMinutes: number,
    runnerName?: string,
    affectedIssues?: number[],
    reason?: string
  ): void {
    const timeStr = resetAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const runnerStr = runnerName ? ` [${runnerName}]` : '';
    const taskStr = affectedIssues && affectedIssues.length > 0 ? ` (Tasks: ${affectedIssues.map(n => `#${n}`).join(', ')})` : '';
    const raw = `⏳ [Quota Limit] Pausing workers until ${timeStr} (~${waitMinutes} min)${runnerStr}${taskStr}`;
    Notifier.emitLog(raw, pc.red(`\n${raw}`));
    const payload: QuotaPausedNotificationPayload = { resetAt, waitMinutes, runnerName, affectedIssues, reason };
    Notifier.emitter.emit('quota_paused', payload);
  }

  public static notifyQuotaResumed(runnerName?: string): void {
    const runnerStr = runnerName ? ` [${runnerName}]` : '';
    const raw = `🔄 [Quota Resumed] Quota limits cleared. Resuming workers.${runnerStr}`;
    Notifier.emitLog(raw, pc.green(`\n${raw}`));
    const payload: QuotaResumedNotificationPayload = { runnerName };
    Notifier.emitter.emit('quota_resumed', payload);
  }

  public static notifyTaskMerged(
    issueNumber: number,
    issueTitle: string,
    prUrl?: string,
    prNumber?: number,
    baseBranch?: string
  ): void {
    const prStr = prUrl ? ` (${prUrl})` : '';
    const raw = `🎉 [Completed & Merged] Issue #${issueNumber}: ${issueTitle}${prStr}`;
    Notifier.emitLog(raw, pc.green(`\n${raw}`));
    const payload: TaskCompletedNotificationPayload = {
      issueNumber,
      issueTitle,
      prUrl,
      prNumber,
      baseBranch,
    };
    Notifier.emitter.emit('task_completed', payload);
  }
}

