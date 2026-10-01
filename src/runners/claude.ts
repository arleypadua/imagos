import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execa } from 'execa';
import type { RunnerResult, TaskContext } from '../types/index.js';
import type { AgentRunner, RunnerOptions } from './base.js';
import { isBinaryAvailable, buildRunnerPrompt } from './base.js';
import { SPAWN_DETACHED, reapAgentProcesses, signalProcessGroup, trackProcessGroup } from './process_tree.js';
import { QuotaMonitor } from '../quota/monitor.js';
import { AgentEventBus } from '../events/bus.js';
import { parseClaudeTranscriptEntry } from '../events/claude_transcript.js';

export function findLatestClaudeSessionId(worktreePath: string): string | undefined {
  try {
    const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(claudeProjectsDir)) return undefined;

    const sanitizedPath = worktreePath.replace(/\//g, '-');
    const projectDirs = fs.readdirSync(claudeProjectsDir);
    const matchDir = projectDirs.find((d) => d.includes(path.basename(worktreePath)) || d === sanitizedPath);

    if (matchDir) {
      const fullMatchPath = path.join(claudeProjectsDir, matchDir);
      const files = fs.readdirSync(fullMatchPath).filter((f) => f.endsWith('.jsonl'));
      if (files.length > 0) {
        const stats = files.map((f) => ({
          file: f,
          mtime: fs.statSync(path.join(fullMatchPath, f)).mtimeMs,
        }));
        stats.sort((a, b) => b.mtime - a.mtime);
        return stats[0].file.replace(/\.jsonl$/, '');
      }
    }
  } catch {}
  return undefined;
}

interface ActiveProcessInfo {
  issueNumber: number;
  subprocess: any;
  isExecutingTool: boolean;
  currentTool?: string;
  pendingPrompt?: string;
  watcher?: { stop: () => void };
}

export class ClaudeRunner implements AgentRunner {
  public readonly name = 'claude';
  private quotaMonitor?: QuotaMonitor;
  private activeProcesses: Map<number, ActiveProcessInfo> = new Map();
  private eventBus = AgentEventBus.getInstance();

  constructor(quotaMonitor?: QuotaMonitor) {
    this.quotaMonitor = quotaMonitor;
  }

  public async isAvailable(): Promise<boolean> {
    return isBinaryAvailable('claude');
  }

  public buildPrompt(context: TaskContext): string {
    return buildRunnerPrompt(context, {
      taskPrefix: (ref) => `/implement ${ref}`,
      codeReviewHint: 'e.g. `/code-review`',
    });
  }

  public async injectPrompt(issueNumber: number, prompt: string): Promise<boolean> {
    const active = this.activeProcesses.get(issueNumber);
    if (!active) {
      return false;
    }

    active.pendingPrompt = prompt;
    this.eventBus.emitAgentEvent({
      issueNumber,
      type: 'prompt_injected',
      summary: `Injected developer feedback: "${prompt}"`,
      detail: { prompt },
    });

    // Wait if tool call is currently running (up to 5s) for graceful completion
    if (active.isExecutingTool) {
      this.eventBus.emitAgentEvent({
        issueNumber,
        type: 'info',
        summary: `Waiting for active tool (${active.currentTool || 'operation'}) to complete before safe resume...`,
      });

      const startTime = Date.now();
      while (active.isExecutingTool && Date.now() - startTime < 5000) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    try {
      active.subprocess.kill('SIGINT');
    } catch {
      // Subprocess might already have exited
    }

    return true;
  }

  public async stop(issueNumber: number): Promise<void> {
    const active = this.activeProcesses.get(issueNumber);
    if (active) {
      // run() escalates to SIGKILL and sweeps the worktree once the agent has exited
      if (active.subprocess.pid) {
        signalProcessGroup(active.subprocess.pid, 'SIGTERM');
        signalProcessGroup(active.subprocess.pid, 'SIGCONT');
      }
      this.cleanupProcess(issueNumber);
    }
  }

  public pause(issueNumber: number): boolean {
    const active = this.activeProcesses.get(issueNumber);
    if (active && active.subprocess.pid) {
      return signalProcessGroup(active.subprocess.pid, 'SIGSTOP');
    }
    return false;
  }

  public resume(issueNumber: number): boolean {
    const active = this.activeProcesses.get(issueNumber);
    if (active && active.subprocess.pid) {
      return signalProcessGroup(active.subprocess.pid, 'SIGCONT');
    }
    return false;
  }

  private cleanupProcess(issueNumber: number): void {
    const active = this.activeProcesses.get(issueNumber);
    if (active) {
      if (active.watcher) {
        active.watcher.stop();
      }
      this.activeProcesses.delete(issueNumber);
    }
  }

  public async run(context: TaskContext, options: RunnerOptions): Promise<RunnerResult> {
    const prompt = this.buildPrompt(context);
    const args = [
      '-p',
      prompt,
      '--dangerously-skip-permissions',
    ];

    if (context.isContinuation) {
      const previousSessionId = findLatestClaudeSessionId(options.cwd);
      if (previousSessionId) {
        args.unshift('--resume', previousSessionId);
      }
    }

    let fullOutput = '';
    const issueNumber = options.issueNumber;
    let pid: number | undefined;

    try {
      const subprocess = execa('claude', args, {
        cwd: options.cwd,
        stdin: 'ignore',
        detached: SPAWN_DETACHED,
        env: {
          ...process.env,
          CI: 'true',
        },
      });

      const procInfo: ActiveProcessInfo = {
        issueNumber,
        subprocess,
        isExecutingTool: false,
      };

      // Start watching Claude's project JSONL for real-time tool calls & thoughts
      procInfo.watcher = this.startClaudeWatcher(options.cwd, issueNumber, procInfo);
      this.activeProcesses.set(issueNumber, procInfo);

      pid = subprocess.pid;
      if (pid) trackProcessGroup(pid);

      if (subprocess.pid && options.onPid) {
        options.onPid(subprocess.pid);
        if (this.quotaMonitor) {
          this.quotaMonitor.registerPid(subprocess.pid, 'claude');
        }
      }

      subprocess.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        fullOutput += text;
        if (options.onOutput) options.onOutput(text);

        // Stream raw stdout lines to event bus
        const lines = text.split('\n').filter(Boolean);
        for (const line of lines) {
          if (line.trim()) {
            this.eventBus.emitAgentEvent({
              issueNumber,
              type: 'stdout',
              summary: line.trim(),
            });
          }
        }

        if (this.quotaMonitor) {
          const quotaCheck = this.quotaMonitor.checkOutputForRateLimit(text);
          if (quotaCheck.isRateLimited && quotaCheck.resetAt) {
            this.quotaMonitor.triggerQuotaPause(quotaCheck.resetAt, quotaCheck.reason, 'claude', [issueNumber]);
          }
        }
      });

      subprocess.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        fullOutput += text;
        if (options.onStderr) options.onStderr(text);
        if (options.onOutput) options.onOutput(text);

        const lines = text.split('\n').filter(Boolean);
        for (const line of lines) {
          if (line.trim()) {
            this.eventBus.emitAgentEvent({
              issueNumber,
              type: 'stderr',
              summary: line.trim(),
            });
          }
        }

        if (this.quotaMonitor) {
          const quotaCheck = this.quotaMonitor.checkOutputForRateLimit(text);
          if (quotaCheck.isRateLimited && quotaCheck.resetAt) {
            this.quotaMonitor.triggerQuotaPause(quotaCheck.resetAt, quotaCheck.reason, 'claude', [issueNumber]);
          }
        }
      });

      await subprocess;

      const pendingPrompt = procInfo.pendingPrompt;
      this.cleanupProcess(issueNumber);

      // Check if prompt was injected while running
      if (pendingPrompt) {
        return {
          success: false,
          status: 'INTERRUPTED_FOR_PROMPT',
          injectedPrompt: pendingPrompt,
          summary: `Interrupted to apply developer prompt: ${pendingPrompt.slice(0, 80)}`,
        };
      }

      // Check if quota limit was met in output
      if (this.quotaMonitor) {
        const quotaCheck = this.quotaMonitor.checkOutputForRateLimit(fullOutput);
        if (quotaCheck.isRateLimited) {
          return {
            success: false,
            status: 'QUOTA_PAUSED',
            quotaResetAt: quotaCheck.resetAt,
            summary: 'Execution paused due to 5-hour rolling quota limit.',
          };
        }
      }

      if (
        /timeout waiting for response/i.test(fullOutput) ||
        /timed?\s*out waiting/i.test(fullOutput)
      ) {
        return {
          success: false,
          status: 'TIMED_OUT',
          isTimeout: true,
          error: 'Execution timed out waiting for response',
          summary: fullOutput.slice(-1000),
        };
      }

      return {
        success: true,
        status: 'COMPLETED',
        summary: fullOutput.slice(-1000),
      };
    } catch (err: any) {
      const active = this.activeProcesses.get(issueNumber);
      const pendingPrompt = active?.pendingPrompt;
      this.cleanupProcess(issueNumber);

      if (pendingPrompt) {
        return {
          success: false,
          status: 'INTERRUPTED_FOR_PROMPT',
          injectedPrompt: pendingPrompt,
          summary: `Interrupted to apply developer prompt: ${pendingPrompt.slice(0, 80)}`,
        };
      }

      if (this.quotaMonitor) {
        const quotaCheck = this.quotaMonitor.checkOutputForRateLimit(`${fullOutput}\n${err.message}`);
        if (quotaCheck.isRateLimited) {
          return {
            success: false,
            status: 'QUOTA_PAUSED',
            quotaResetAt: quotaCheck.resetAt,
            summary: 'Execution paused due to Claude quota limits.',
          };
        }
      }

      const isTimeout =
        err.timedOut === true ||
        /timeout waiting for response/i.test(err.message || '') ||
        /timeout waiting for response/i.test(fullOutput) ||
        /timed?\s*out/i.test(err.message || '') ||
        /timed?\s*out/i.test(fullOutput) ||
        err.code === 'ETIMEDOUT';

      if (isTimeout) {
        return {
          success: false,
          status: 'TIMED_OUT',
          isTimeout: true,
          error: err.message || String(err),
          summary: fullOutput.slice(-1000) || 'Execution timed out waiting for response',
        };
      }

      return {
        success: false,
        status: 'FAILED',
        error: err.message || String(err),
        summary: fullOutput.slice(-1000),
      };
    } finally {
      if (pid && this.quotaMonitor) {
        this.quotaMonitor.unregisterPid(pid);
      }
      await reapAgentProcesses(pid, options.cwd);
    }
  }

  private startClaudeWatcher(
    worktreePath: string,
    issueNumber: number,
    procInfo: ActiveProcessInfo
  ): { stop: () => void } {
    let lastLineCount = 0;
    let currentFile: string | undefined;

    const check = () => {
      try {
        const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
        if (!fs.existsSync(claudeProjectsDir)) return;

        const sanitizedPath = worktreePath.replace(/\//g, '-');
        const projectDirs = fs.readdirSync(claudeProjectsDir);
        const matchDir = projectDirs.find((d) => d.includes(path.basename(worktreePath)) || d === sanitizedPath);
        if (!matchDir) return;

        const fullMatchPath = path.join(claudeProjectsDir, matchDir);
        const files = fs.readdirSync(fullMatchPath).filter((f) => f.endsWith('.jsonl'));
        if (files.length === 0) return;

        const stats = files.map((f) => ({
          file: f,
          mtime: fs.statSync(path.join(fullMatchPath, f)).mtimeMs,
        }));
        stats.sort((a, b) => b.mtime - a.mtime);
        const latestFile = path.join(fullMatchPath, stats[0].file);

        if (latestFile !== currentFile) {
          currentFile = latestFile;
          lastLineCount = 0;
        }

        const content = fs.readFileSync(latestFile, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        if (lines.length > lastLineCount) {
          const newLines = lines.slice(lastLineCount);
          lastLineCount = lines.length;

          for (const line of newLines) {
            try {
              const parsed = JSON.parse(line);
              for (const evt of parseClaudeTranscriptEntry(parsed)) {
                if (evt.type === 'tool_start') {
                  procInfo.isExecutingTool = true;
                  procInfo.currentTool = evt.detail?.name;
                } else if (evt.type === 'tool_end') {
                  procInfo.isExecutingTool = false;
                  procInfo.currentTool = undefined;
                }
                this.eventBus.emitAgentEvent({ issueNumber, ...evt });
              }
            } catch {}
          }
        }
      } catch {}
    };

    const timer = setInterval(check, 600);
    // Initial check after short delay
    setTimeout(check, 300);

    return {
      stop: () => clearInterval(timer),
    };
  }
}
