#!/usr/bin/env node

import './env.js';
import { Command } from 'commander';
import pc from 'picocolors';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as readline from 'node:readline/promises';
import { execa } from 'execa';
import {
  loadConfig,
  saveConfig,
  detectRepository,
  getConfigPath,
  parseSpecsOption,
  loadUserConfig,
  saveTelegramBot,
  parseAllowedChatIds,
  saveTelegramCredentials,
  parseAllowedUserIds,
} from './config/schema.js';
import { Orchestrator } from './pipeline/orchestrator.js';
import { GitHubClient } from './github/client.js';
import { IssueDAG } from './github/dag.js';
import { WorktreeManager } from './worktree/manager.js';
import { StateManager } from './state/manager.js';
import { isBinaryAvailable } from './runners/base.js';
import type { DAGNode, GitHubLabel } from './types/index.js';
import Table from 'cli-table3';

export { parseSpecsOption };

async function promptNewBot(rl: readline.Interface, initialHandle?: string): Promise<string> {
  let handle = initialHandle;
  if (!handle) {
    const handleAns = await rl.question(pc.yellow('Enter Telegram Bot Handle (e.g. @imagos_backend_bot): '));
    handle = handleAns.trim();
  }
  if (!handle) {
    handle = '@imagos_bot';
  }
  const normalizedHandle = handle.startsWith('@') ? handle : `@${handle}`;

  const tokenAns = await rl.question(pc.yellow(`Enter Bot Token for ${normalizedHandle}: `));
  const token = tokenAns.trim();

  const chatIdsAns = await rl.question(
    pc.yellow('Enter Allowed Chat IDs (comma-separated, e.g. 123456789, or leave empty): ')
  );
  const allowedChatIds = parseAllowedChatIds(chatIdsAns) || [];

  if (token) {
    saveTelegramBot(normalizedHandle, { token, allowedChatIds });
    console.log(pc.green(`✓ Saved bot credentials for ${pc.bold(normalizedHandle)} in ~/.imagos/config.json`));
  } else {
    console.log(pc.yellow(`⚠️ Warning: No token entered. Saved handle ${normalizedHandle} without token.`));
  }

  return normalizedHandle;
}

function getPackageVersion(): string {
  try {
    const pkgPath = new URL('../package.json', import.meta.url);
    const raw = fs.readFileSync(pkgPath, 'utf8');
    return JSON.parse(raw).version || '0.4.0';
  } catch {
    return '0.4.0';
  }
}

const program = new Command();

program
  .name('imagos')
  .description('Autonomous multi-agent GitHub issue orchestrator powered by Claude CLI & git worktrees')
  .version(getPackageVersion());

// 1. START COMMAND
program
  .command('start')
  .description('Start the autonomous orchestrator daemon with live terminal dashboard')
  .option('-c, --config <path>', 'Path to config.json')
  .option('-r, --repo <owner/repo>', 'Target GitHub repository (e.g. owner/repo)')
  .option('-s, --spec <specs...>', 'Scope execution strictly to child tickets of specific Spec issue(s)', parseSpecsOption)
  .option('--specs <specs...>', 'Alias for --spec', parseSpecsOption)
  .option('-m, --concurrency <number>', 'Maximum parallel tasks', parseInt)
  .option('--runner <runner>', 'Runner to use (claude, agy, pi, custom)')
  .option('--no-interactive', 'Disable interactive TUI dashboard (useful for CI/headless environments)')
  .option('--remote', 'Enable remote control via Telegram')
  .option('--no-remote', 'Disable remote control')
  .action(async (options) => {
    try {
      const config = await loadConfig(options.config);
      if (options.repo) config.repository = options.repo;
      const specOptions = [...(options.spec || []), ...(options.specs || [])];
      if (specOptions.length > 0) {
        config.targetSpecs = Array.from(new Set(specOptions));
        delete config.targetSpec;
      }
      if (options.concurrency) config.maxConcurrency = options.concurrency;
      if (options.runner) config.runner = options.runner;
      if (options.remote !== undefined) {
        if (!config.remote) {
          config.remote = {
            enabled: options.remote,
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
          };
        } else {
          config.remote.enabled = options.remote;
        }
      }

      if (!config.repository) {
        console.error(
          pc.red('Error: Target repository not specified and could not be detected from git remote.')
        );
        console.log(pc.yellow('Please specify via --repo <owner/repo> or in .autopilot/config.json'));
        process.exit(1);
      }

      const orchestrator = new Orchestrator(config);
      const isInteractive = options.interactive !== false && Boolean(process.stdout.isTTY);

      if (isInteractive) {
        const { startInteractiveDashboard } = await import('./ui/interactive.js');
        let tui: any;
        let isShuttingDown = false;
        const shutdown = async (signal?: string) => {
          if (isShuttingDown) return;
          isShuttingDown = true;
          try {
            tui?.unmount();
          } catch {}
          try {
            await orchestrator.stop();
          } catch (err: any) {
            console.error(pc.red(`Error during shutdown: ${err.message}`));
          }
          process.exit(0);
        };

        process.on('SIGINT', () => { shutdown('SIGINT'); });
        process.on('SIGTERM', () => { shutdown('SIGTERM'); });

        tui = startInteractiveDashboard(orchestrator, async () => {
          await shutdown();
        });

        await orchestrator.start();
        await tui.waitUntilExit();
        await shutdown();
      } else {
        console.log(pc.cyan(`Starting Imagos for ${config.repository} (headless mode)...`));
        let isShuttingDown = false;
        const shutdown = async (signal?: string) => {
          if (isShuttingDown) return;
          isShuttingDown = true;
          console.log(pc.yellow(`\nShutting down gracefully${signal ? ` (${signal})` : ''}...`));
          try {
            await orchestrator.stop();
          } catch (err: any) {
            console.error(pc.red(`Error during shutdown: ${err.message}`));
          }
          process.exit(0);
        };

        process.on('SIGINT', () => { shutdown('SIGINT'); });
        process.on('SIGTERM', () => { shutdown('SIGTERM'); });

        await orchestrator.start();
      }
    } catch (err: any) {
      console.error(pc.red(`Fatal Error: ${err.message}`));
      process.exit(1);
    }
  });

// 2. INIT COMMAND
program
  .command('init')
  .description('Initialize .autopilot/config.json for the current project')
  .option('-r, --repo <owner/repo>', 'GitHub repository')
  .option('--runner <runner>', 'Default runner to configure (e.g. claude, agy)')
  .option('--telegram', 'Enable Telegram integration')
  .option('--no-telegram', 'Disable Telegram integration')
  .option('--telegram-bot <handle>', 'Telegram bot handle (e.g. @imagos_backend_bot)')
  .option('--telegram-token <token>', 'Telegram bot token (saved to ~/.imagos/config.json)')
  .option('--telegram-chat-ids <ids>', 'Allowed chat IDs (comma-separated, e.g. 123456789,-1001234567890)')
  .option('--remote', 'Enable remote control via Telegram')
  .option('--no-remote', 'Disable remote control')
  .option('--bot-token <token>', 'Telegram bot token (saved to credentials.json)')
  .option('--user-id <id>', 'Allowed Telegram user ID')
  .action(async (options) => {
    try {
      const detectedRepo = options.repo || (await detectRepository());

      let selectedRunner = options.runner;
      let remoteEnabled = options.remote ?? options.telegram ?? false;
      let botToken = options.botToken ?? options.telegramToken;
      let allowedUserIds = options.userId ? parseAllowedUserIds(options.userId) : undefined;
      let allowedChatIds = options.telegramChatIds ? parseAllowedChatIds(options.telegramChatIds) : undefined;
      let selectedBotHandle = options.telegramBot;

      if (options.botToken || options.userId || options.telegramToken || options.telegramChatIds || options.telegramBot) {
        if (options.remote !== false && options.telegram !== false) {
          remoteEnabled = true;
        }
      }

      let rl: readline.Interface | undefined;

      const getRl = () => {
        if (!rl && process.stdin.isTTY) {
          rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
        }
        return rl;
      };

      try {
        if (!selectedRunner) {
          const hasClaude = await isBinaryAvailable('claude');
          const hasAgy = await isBinaryAvailable('agy');

          if (hasClaude && !hasAgy) {
            selectedRunner = 'claude';
            console.log(pc.cyan('\n✓ Auto-detected runner: ') + pc.bold(pc.green('Claude Code CLI (claude)')) + pc.gray(' (only installed provider found)'));
          } else if (hasAgy && !hasClaude) {
            selectedRunner = 'agy';
            console.log(pc.cyan('\n✓ Auto-detected runner: ') + pc.bold(pc.green('Antigravity CLI (agy)')) + pc.gray(' (only installed provider found)'));
          } else if (process.stdin.isTTY) {
            const promptRl = getRl();
            if (promptRl) {
              if (hasClaude && hasAgy) {
                console.log(pc.cyan('\nMultiple LLM runners detected on your system:'));
                console.log(`  ${pc.bold('1)')} Claude Code CLI (${pc.green('claude')}) [installed] [default]`);
                console.log(`  ${pc.bold('2)')} Antigravity CLI (${pc.green('agy')}) [installed]`);
              } else {
                console.log(pc.yellow('\nNo supported runner CLIs (claude, agy) detected in PATH.'));
                console.log(pc.cyan('Select the default LLM runner to configure:'));
                console.log(`  ${pc.bold('1)')} Claude Code CLI (${pc.green('claude')}) [default]`);
                console.log(`  ${pc.bold('2)')} Antigravity CLI (${pc.green('agy')})`);
              }

              const answer = await promptRl.question(pc.yellow('\nChoose runner [1/2 or name] (default: 1): '));
              const trimmed = answer.trim().toLowerCase();
              if (trimmed === '2' || trimmed === 'agy') {
                selectedRunner = 'agy';
              } else if (trimmed === '1' || trimmed === 'claude' || trimmed === '') {
                selectedRunner = 'claude';
              } else {
                selectedRunner = trimmed;
              }
            }
          }
        }

        if (options.remote === undefined && options.telegram === undefined && !options.botToken && !options.telegramToken && !options.userId && !options.telegramBot && process.stdin.isTTY) {
          const promptRl = getRl();
          if (promptRl) {
            console.log(pc.cyan('\nTelegram Remote Control:'));
            console.log(pc.gray('Allows monitoring notifications, answering questions, and sending commands via Telegram.'));
            const remoteAnswer = await promptRl.question(pc.yellow('Enable Telegram remote control? [y/N]: '));
            const isYes = ['y', 'yes', 'true', '1'].includes(remoteAnswer.trim().toLowerCase());
            if (isYes) {
              remoteEnabled = true;
              const tokenAnswer = await promptRl.question(pc.yellow('Enter Telegram Bot Token (from @BotFather, press Enter to skip): '));
              if (tokenAnswer.trim()) {
                botToken = tokenAnswer.trim();
              }
              const userAnswer = await promptRl.question(pc.yellow('Enter your Telegram User ID (numeric, from @userinfobot, press Enter to skip): '));
              if (userAnswer.trim()) {
                allowedUserIds = parseAllowedUserIds(userAnswer.trim());
              }
            }
          }
        }
      } finally {
        if (rl) {
          rl.close();
        }
      }

      const runner = selectedRunner || 'claude';

      // Save credentials if provided
      if (selectedBotHandle && botToken) {
        saveTelegramBot(selectedBotHandle, {
          token: botToken,
          allowedChatIds: allowedChatIds || [],
        });
        console.log(pc.green(`✓ Saved bot credentials for ${pc.bold(selectedBotHandle)} in ~/.imagos/credentials.json`));
      } else if (botToken || (allowedUserIds && allowedUserIds.length > 0)) {
        const savedCredsPath = saveTelegramCredentials({
          repository: detectedRepo && detectedRepo !== 'owner/repo' ? detectedRepo : undefined,
          botToken: botToken ? botToken.trim() : undefined,
          allowedUserIds: allowedUserIds && allowedUserIds.length > 0 ? allowedUserIds : undefined,
        });
        console.log(pc.green(`✓ Saved Telegram credentials to ${savedCredsPath}`));
      }

      const config: Record<string, any> = {
        $schema: 'https://raw.githubusercontent.com/arleypadua/imagos/main/schema.json',
        repository: detectedRepo || 'owner/repo',
        baseBranch: 'main',
        maxConcurrency: 2,
        pollIntervalSeconds: 30,
        extraPrompt: '',
        runner,
        autoMerge: true,
        mergeMethod: 'squash',
        cleanupWorktreeOnClose: true,
        remote: {
          enabled: remoteEnabled,
          provider: 'telegram',
          telegram: {
            botTokenEnv: 'TELEGRAM_BOT_TOKEN',
            ...(selectedBotHandle ? { bot: selectedBotHandle } : {}),
            ...(allowedUserIds && allowedUserIds.length > 0 ? { allowedUserIds } : {}),
            ...(allowedChatIds && allowedChatIds.length > 0 ? { allowedChatIds } : {}),
            notifications: {
              needsInfo: true,
              quotaPaused: true,
              taskCompleted: true,
              specCompleted: true,
            },
          },
        },
        quota: {
          pauseOnLimit: true,
          utilizationThresholdLimit: 0.85,
        },
        labels: {
          readyForAgent: 'ready-for-agent',
          needsInfo: 'needs-info',
          readyForHuman: 'ready-for-human',
          needsTriage: 'needs-triage',
          wontfix: 'wontfix',
        },
      };

      if (selectedBotHandle && remoteEnabled) {
        config.telegram = {
          enabled: true,
          bot: selectedBotHandle,
        };
      }

      const savedPath = saveConfig(config as any);
      console.log(pc.green(`\n✓ Created ${savedPath}`));
      console.log(pc.green(`✓ Configured default runner: ${pc.bold(runner)}`));
      if (selectedBotHandle) {
        console.log(pc.green(`✓ Configured Telegram bot handle: ${pc.bold(selectedBotHandle)}`));
      }
      console.log(pc.green(`✓ Configured remote control: ${pc.bold(remoteEnabled ? 'Telegram (enabled)' : 'Telegram (disabled)')}`));
      console.log(pc.green('✓ Updated .gitignore (tracking config.json, ignoring runtime state/worktrees)'));
    } catch (err: any) {
      console.error(pc.red(`Failed to initialize config: ${err.message}`));
      process.exit(1);
    }
  });

// 3. STATUS COMMAND
program
  .command('status')
  .description('Display runtime metadata, active task sessions, worktrees, and DAG')
  .option('-c, --config <path>', 'Path to config.json')
  .option('-R, --repo <owner/repo>', 'Target GitHub repository (e.g. owner/repo)')
  .option('-s, --spec <specs...>', 'Scope display strictly to child tickets of specific Spec issue(s)', parseSpecsOption)
  .option('--specs <specs...>', 'Alias for --spec', parseSpecsOption)
  .action(async (options) => {
    try {
      const config = await loadConfig(options.config);
      if (options.repo) config.repository = options.repo;
      const specOptions = [...(options.spec || []), ...(options.specs || [])];
      if (specOptions.length > 0) {
        config.targetSpecs = Array.from(new Set(specOptions));
        delete config.targetSpec;
      }
      const stateMgr = new StateManager();
      const runtimeState = stateMgr.getState();

      const gh = new GitHubClient({ repository: config.repository });
      const issues = await gh.fetchIssues();

      const dag = new IssueDAG(config);
      dag.build(issues);

      const worktreeMgr = new WorktreeManager();
      const activeWorktrees = await worktreeMgr.listActiveWorktrees();

      console.log(pc.bold(pc.cyan(`\n=== AGENT AUTO-PILOT RUNTIME STATE ===\n`)));
      console.log(`Repository: ${pc.bold(config.repository || 'Local')}`);
      const targetSpecs = dag.getTargetSpecs();
      if (targetSpecs.length === 1) {
        console.log(`Scoped Spec: ${pc.bold(`#${targetSpecs[0]}`)}`);
      } else if (targetSpecs.length > 1) {
        console.log(`Scoped Specs: ${pc.bold(targetSpecs.map((s) => `#${s}`).join(', '))}`);
      }
      console.log(`Daemon Status: ${pc.bold(runtimeState.daemonStatus)}`);
      if (runtimeState.quotaPausedUntil) {
        console.log(pc.red(`Quota Paused Until: ${runtimeState.quotaPausedUntil}`));
      }
      console.log('');

      // Active Sessions from state.json
      console.log(pc.bold('Active Task Sessions (.autopilot/sessions/):'));
      const activeTaskEntries = Object.values(runtimeState.activeTasks);
      if (activeTaskEntries.length === 0) {
        console.log(pc.gray('  No active sessions currently running.\n'));
      } else {
        const sessionTable = new Table({
          head: [pc.cyan('Issue'), pc.cyan('Title'), pc.cyan('Status'), pc.cyan('Worktree Path')],
        });
        for (const task of activeTaskEntries) {
          sessionTable.push([`#${task.issueNumber}`, task.title.slice(0, 30), task.status, task.worktreePath]);
        }
        console.log(sessionTable.toString());
        console.log('');
      }

      // Worktrees Table
      console.log(pc.bold('Active Worktrees on Disk:'));
      if (activeWorktrees.length === 0) {
        console.log(pc.gray('  No active worktrees found in .autopilot/worktrees/\n'));
      } else {
        const wtTable = new Table({
          head: [pc.cyan('Issue #'), pc.cyan('Branch'), pc.cyan('Worktree Path')],
        });
        for (const wt of activeWorktrees) {
          wtTable.push([wt.issueNumber ? `#${wt.issueNumber}` : 'N/A', wt.branch, wt.path]);
        }
        console.log(wtTable.toString());
        console.log('');
      }

      // Issue DAG Table
      console.log(pc.bold('GitHub Issue DAG:'));
      const issueTable = new Table({
        head: [pc.cyan('Issue'), pc.cyan('Runner'), pc.cyan('Title'), pc.cyan('Kind'), pc.cyan('Status'), pc.cyan('Blockers')],
      });

      const displayNodes = targetSpecs.length > 0
        ? dag.getAllNodes().filter((n) => {
            const childIds = new Set<number>();
            for (const s of targetSpecs) {
              for (const c of dag.getSpecChildIssueNumbers(s)) {
                childIds.add(c);
              }
              childIds.add(s);
            }
            return childIds.has(n.issue.number);
          })
        : dag.getAllNodes();

      for (const node of displayNodes) {
        let statusColor = pc.gray(node.status);
        if (node.status === 'ready') statusColor = pc.green(node.status);
        if (node.status === 'waiting_feedback') statusColor = pc.yellow(node.status);
        if (node.status === 'blocked') statusColor = pc.red(node.status);

        issueTable.push([
          `#${node.issue.number}`,
          pc.cyan(node.runnerName || config.runner),
          node.issue.title.slice(0, 26),
          node.kind,
          statusColor,
          node.blockers.length > 0 ? node.blockers.join(', ') : pc.gray('None'),
        ]);
      }

      console.log(issueTable.toString());
    } catch (err: any) {
      console.error(pc.red(`Status error: ${err.message}`));
      process.exit(1);
    }
  });

// 4. LOGS COMMAND
program
  .command('logs <issueNumber>')
  .description('View execution output logs for a specific issue from .autopilot/sessions/')
  .option('-t, --tail <lines>', 'Number of lines to show', '50')
  .action((issueNumberStr, options) => {
    const issueNumber = parseInt(issueNumberStr, 10);
    const stateMgr = new StateManager();
    const session = stateMgr.getSession(issueNumber);

    if (!session.metadata && !session.stdout) {
      console.log(pc.yellow(`No session logs found for Issue #${issueNumber} in .autopilot/sessions/issue-${issueNumber}/`));
      return;
    }

    console.log(pc.bold(pc.cyan(`\n=== SESSION LOGS: Issue #${issueNumber} ===\n`)));
    if (session.metadata) {
      console.log(`Title: ${session.metadata.title}`);
      console.log(`Branch: ${session.metadata.branchName}`);
      console.log(`Status: ${session.metadata.status}`);
      console.log(`Started: ${session.metadata.startedAt}`);
      console.log('');
    }

    if (session.stdout) {
      console.log(pc.bold('Output Stream (stdout):'));
      const lines = session.stdout.split('\n');
      const tailCount = parseInt(options.tail, 10);
      const displayLines = lines.slice(-tailCount).join('\n');
      console.log(displayLines);
    }

    if (session.stderr && session.stderr.trim()) {
      console.log(pc.bold(pc.red('\nErrors (stderr):')));
      console.log(session.stderr);
    }
  });

// 5. INSPECT COMMAND (Live Agent Activity & Git Diff)
program
  .command('inspect <issueNumber>')
  .alias('diff')
  .description('Inspect what the agent is currently doing (live tool calls, modified files, diff stat)')
  .action(async (issueNumberStr) => {
    const issueNumber = parseInt(issueNumberStr, 10);
    const worktreeMgr = new WorktreeManager();
    const worktreePath = worktreeMgr.getWorktreePathForIssue(issueNumber);

    console.log(pc.bold(pc.cyan(`\n=== LIVE AGENT INSPECTION: Issue #${issueNumber} ===\n`)));

    if (!fs.existsSync(worktreePath)) {
      console.log(pc.yellow(`No active worktree found at ${worktreePath}`));
      return;
    }

    console.log(`Worktree: ${pc.bold(worktreePath)}`);

    // 1. Git Status & Uncommitted Changes
    try {
      const { stdout: statusOut } = await execa('git', ['status', '--short'], { cwd: worktreePath });
      console.log(pc.bold('\n📁 Modified Files in Worktree:'));
      if (!statusOut.trim()) {
        console.log(pc.gray('  No uncommitted file modifications yet.'));
      } else {
        console.log(statusOut);
      }

      const { stdout: diffStat } = await execa('git', ['diff', '--stat'], { cwd: worktreePath });
      if (diffStat.trim()) {
        console.log(pc.bold('\n📊 Diff Summary:'));
        console.log(diffStat);
      }
    } catch {
      // Best effort
    }

    // 2. Claude Session Inspection from ~/.claude/projects/
    try {
      const homeDir = os.homedir();
      const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');
      if (fs.existsSync(claudeProjectsDir)) {
        const sanitizedPath = worktreePath.replace(/\//g, '-');
        const projectDirs = fs.readdirSync(claudeProjectsDir);
        const matchDir = projectDirs.find((d) => d.includes(`issue-${issueNumber}`) || d === sanitizedPath);

        if (matchDir) {
          const fullMatchPath = path.join(claudeProjectsDir, matchDir);
          const files = fs.readdirSync(fullMatchPath).filter((f) => f.endsWith('.jsonl'));
          if (files.length > 0) {
            // Find most recently modified jsonl file
            const stats = files.map((f) => ({
              file: f,
              mtime: fs.statSync(path.join(fullMatchPath, f)).mtimeMs,
            }));
            stats.sort((a, b) => b.mtime - a.mtime);
            const latestJsonl = path.join(fullMatchPath, stats[0].file);

            const content = fs.readFileSync(latestJsonl, 'utf8');
            const lines = content.split('\n').filter(Boolean);
            const recentLines = lines.slice(-20);

            console.log(pc.bold('\n⚡ Recent Agent Tool Calls & Activities:'));
            const activities: string[] = [];

            for (const line of recentLines) {
              try {
                const parsed = JSON.parse(line);
                if (parsed.type === 'assistant' && parsed.message?.content) {
                  for (const block of parsed.message.content) {
                    if (block.type === 'tool_use') {
                      activities.push(
                        `  🔧 ${pc.cyan(block.name)}: ${JSON.stringify(block.input || {}).slice(0, 100)}`
                      );
                    } else if (block.type === 'text' && block.text) {
                      activities.push(`  💬 ${pc.gray(block.text.slice(0, 120).replace(/\n/g, ' '))}`);
                    }
                  }
                } else if (parsed.type === 'user' && parsed.message?.content) {
                  for (const block of parsed.message.content) {
                    if (block.type === 'tool_result' && block.tool_use_id) {
                      activities.push(`  ✓ ${pc.green('Tool Result received')}`);
                    }
                  }
                }
              } catch {
                // Ignore malformed lines
              }
            }

            if (activities.length > 0) {
              const display = activities.slice(-8);
              for (const act of display) {
                console.log(act);
              }
            } else {
              console.log(pc.gray('  Agent is analyzing repository context...'));
            }
          }
        }
      }
    } catch {
      // Best effort
    }
    console.log('');
  });

// 6. BACKLOG / QUEUE COMMAND
program
  .command('backlog')
  .alias('queue')
  .description('Inspect the issue backlog (ready for agent, waiting on human, blocked by deps, etc.)')
  .option('-c, --config <path>', 'Path to config.json')
  .option('-R, --repo <owner/repo>', 'Target GitHub repository (e.g. owner/repo)')
  .option('-s, --spec <specs...>', 'Filter backlog strictly to child tickets of specific Spec issue(s)', parseSpecsOption)
  .option('--specs <specs...>', 'Alias for --spec', parseSpecsOption)
  .option('-r, --ready', 'Show only issues ready for agent execution')
  .option('-p, --pending', 'Show only issues pending on developer feedback (needs-info / ready-for-human)')
  .option('-b, --blocked', 'Show only issues blocked by dependencies')
  .option('-t, --triage', 'Show only issues needing triage')
  .option('--json', 'Serialize backlog nodes as JSON array to stdout')
  .action(async (options) => {
    try {
      const config = await loadConfig(options.config);
      if (options.repo) config.repository = options.repo;
      const specOptions = [...(options.spec || []), ...(options.specs || [])];
      if (specOptions.length > 0) {
        config.targetSpecs = Array.from(new Set(specOptions));
        delete config.targetSpec;
      }
      const gh = new GitHubClient({ repository: config.repository });
      const issues = await gh.fetchIssues();

      const dag = new IssueDAG(config);
      dag.build(issues);

      const targetSpecs = dag.getTargetSpecs();
      const childIds = new Set<number>();
      if (targetSpecs.length > 0) {
        for (const s of targetSpecs) {
          for (const c of dag.getSpecChildIssueNumbers(s)) {
            childIds.add(c);
          }
          childIds.add(s);
        }
      }

      const allNodes = dag.getAllNodes();
      const readyNodes = dag.getReadyNodes();
      const waitingNodes = dag.getWaitingFeedbackNodes();
      const blockedNodes = dag.getBlockedNodes();
      const triageNodes = dag.getTriageNodes();

      const filterActive = options.ready || options.pending || options.blocked || options.triage;

      if (options.json) {
        const resultNodes: DAGNode[] = [];
        if (filterActive) {
          if (options.pending) resultNodes.push(...waitingNodes);
          if (options.ready) resultNodes.push(...readyNodes);
          if (options.blocked) resultNodes.push(...blockedNodes);
          if (options.triage) resultNodes.push(...triageNodes);
        } else {
          resultNodes.push(...waitingNodes, ...readyNodes, ...blockedNodes, ...triageNodes);
        }

        const seen = new Set<number>();
        const uniqueNodes = resultNodes.filter((node) => {
          if (seen.has(node.issue.number)) return false;
          seen.add(node.issue.number);
          return true;
        });

        console.log(JSON.stringify(uniqueNodes, null, 2));
        return;
      }

      console.log(pc.bold(pc.cyan(`\n=== ISSUE BACKLOG & QUEUE: ${config.repository || 'Local'} ===\n`)));

      // 1. HUMAN ACTION REQUIRED (TASKS & FEEDBACK)
      if (!filterActive || options.pending) {
        console.log(pc.bold(pc.yellow(`📌 Human Action Required (${waitingNodes.length}):`)));
        if (waitingNodes.length === 0) {
          console.log(pc.gray('  No issues waiting for human input.\n'));
        } else {
          for (const node of waitingNodes) {
            const latestComment = node.issue.comments?.[node.issue.comments.length - 1]?.body;
            console.log(
              `  ${pc.bold(pc.yellow(`#${node.issue.number}`))} ${pc.bold(node.issue.title)} ${pc.gray(`(${node.kind})`)}`
            );
            console.log(`    URL: ${pc.cyan(node.issue.url)}`);
            if (latestComment) {
              const preview = latestComment.replace(/\n+/g, ' ').slice(0, 100);
              console.log(`    ${pc.gray('Question/Comment:')} "${preview}${latestComment.length > 100 ? '...' : ''}"`);
            }
            console.log('');
          }
        }
      }

      // 2. READY FOR AGENT
      if (!filterActive || options.ready) {
        console.log(pc.bold(pc.green(`🚀 Ready for Agent Execution (${readyNodes.length}):`)));
        if (readyNodes.length === 0) {
          console.log(pc.gray('  No issues ready for agent execution.\n'));
        } else {
          const table = new Table({
            head: [pc.cyan('Issue'), pc.cyan('Runner'), pc.cyan('Title'), pc.cyan('Kind'), pc.cyan('Labels')],
            colWidths: [10, 12, 30, 14, 25],
          });
          for (const node of readyNodes) {
            table.push([
              `#${node.issue.number}`,
              pc.cyan(node.runnerName || config.runner),
              node.issue.title.slice(0, 28),
              node.kind,
              node.issue.labels.map((l) => l.name).join(', ').slice(0, 23),
            ]);
          }
          console.log(table.toString());
          console.log('');
        }
      }

      // 3. BLOCKED BY DEPENDENCIES
      if (!filterActive || options.blocked) {
        console.log(pc.bold(pc.red(`⏳ Blocked by Dependencies (${blockedNodes.length}):`)));
        if (blockedNodes.length === 0) {
          console.log(pc.gray('  No issues blocked by dependencies.\n'));
        } else {
          const table = new Table({
            head: [pc.cyan('Issue'), pc.cyan('Title'), pc.cyan('Waiting on Blockers')],
            colWidths: [10, 40, 30],
          });
          for (const node of blockedNodes) {
            const unresolved = dag.getUnresolvedBlockers(node.issue.number);
            table.push([
              `#${node.issue.number}`,
              node.issue.title.slice(0, 38),
              unresolved.map((id) => `#${id}`).join(', ') || 'Parent/Blocker Open',
            ]);
          }
          console.log(table.toString());
          console.log('');
        }
      }

      // 4. NEEDS TRIAGE
      if (!filterActive || options.triage) {
        console.log(pc.bold(pc.gray(`📋 Needs Triage / Other Open Issues (${triageNodes.length}):`)));
        if (triageNodes.length === 0) {
          console.log(pc.gray('  No un-triaged open issues.\n'));
        } else {
          for (const node of triageNodes.slice(0, 10)) {
            console.log(`  #${node.issue.number}: ${node.issue.title} ${pc.gray(`[${node.issue.labels.map((l: GitHubLabel) => l.name).join(', ')}]`)}`);
          }
          if (triageNodes.length > 10) {
            console.log(pc.gray(`  ... and ${triageNodes.length - 10} more`));
          }
          console.log('');
        }
      }
    } catch (err: any) {
      console.error(pc.red(`Backlog error: ${err.message}`));
      process.exit(1);
    }
  });

// 7. CLEAN COMMAND
program
  .command('clean')
  .description('Clean up all inactive worktrees and temporary agent branches')
  .action(async () => {
    try {
      const worktreeMgr = new WorktreeManager();
      const worktrees = await worktreeMgr.listActiveWorktrees();

      console.log(pc.cyan(`Cleaning up ${worktrees.length} worktrees...`));
      for (const wt of worktrees) {
        if (wt.issueNumber) {
          await worktreeMgr.cleanupWorktree(wt.issueNumber, undefined, true);
          console.log(pc.green(`✓ Removed worktree for issue #${wt.issueNumber}`));
        }
      }
      console.log(pc.green('✓ All agent worktrees cleaned up.'));
    } catch (err: any) {
      console.error(pc.red(`Clean error: ${err.message}`));
      process.exit(1);
    }
  });

// 8. RESUME / UNPAUSE COMMAND
program
  .command('resume')
  .alias('unpause')
  .description('Instantly clear quota pause and force immediate task execution (e.g. after plan upgrade)')
  .action(() => {
    try {
      const stateMgr = new StateManager();
      stateMgr.updateDaemonStatus('running', undefined);
      console.log(pc.green('✓ Quota pause cleared. Daemon status set to running.'));
      console.log(pc.cyan('The orchestrator will immediately resume dispatching tasks without waiting.'));
    } catch (err: any) {
      console.error(pc.red(`Resume error: ${err.message}`));
      process.exit(1);
    }
  });

// 9. INSTALL-SKILLS COMMAND
program
  .command('install-skills')
  .alias('skills')
  .description('Install Imagos AI skills into your AI agent environment via skills.sh (vercel-labs/skills)')
  .option('-g, --global', 'Install skills globally')
  .option('-a, --agent <agent>', 'Target specific AI agent (e.g. claude, antigravity, cursor, windsurf)')
  .option('-r, --repo <repo>', 'Skill repository or source', 'arleypadua/imagos')
  .option('-s, --skill <skill>', 'Specific skill to install (e.g. imagos-summary, imagos-spec-writer)')
  .action(async (options) => {
    try {
      console.log(pc.bold(pc.cyan('\n=== INSTALLING IMAGOS AI SKILLS ===\n')));
      const args = ['skills', 'add', options.repo];
      if (options.global) args.push('-g');
      if (options.agent) args.push('-a', options.agent);
      if (options.skill) args.push('-s', options.skill);

      console.log(pc.gray(`Executing: npx ${args.join(' ')}`));

      const subprocess = execa('npx', args, {
        stdio: 'inherit',
      });
      await subprocess;
      console.log(pc.green('\n✓ Imagos skills installed successfully!'));
    } catch (err: any) {
      console.error(pc.red(`\nSkill installation failed: ${err.message}`));
      process.exit(1);
    }
  });

export { program };

if (!process.env.VITEST) {
  program.parse(process.argv);
}


