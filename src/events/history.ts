import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AgentEvent } from './bus.js';
import { AgentEventBus } from './bus.js';
import { parseClaudeTranscriptEntry } from './claude_transcript.js';

// Full session history for the inspect view, bounded so huge sessions stay responsive.
const MAX_TRANSCRIPT_LINES = 1500;
import { StateManager } from '../state/manager.js';
import { WorktreeManager } from '../worktree/manager.js';

export function loadHistoricalEvents(issueNumber: number, worktreePath?: string): AgentEvent[] {
  const eventBus = AgentEventBus.getInstance();
  const existingHistory = eventBus.getHistory(issueNumber);
  if (existingHistory.length > 0) {
    return existingHistory;
  }

  const events: AgentEvent[] = [];
  const stateMgr = new StateManager();
  const session = stateMgr.getSession(issueNumber);

  const worktreeMgr = new WorktreeManager();
  const targetWorktree = worktreePath || session.metadata?.worktreePath || worktreeMgr.getWorktreePathForIssue(issueNumber);

  // 1. Check Claude session JSONL in ~/.claude/projects/
  try {
    const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (fs.existsSync(claudeProjectsDir)) {
      const sanitizedPath = targetWorktree.replace(/\//g, '-');
      const projectDirs = fs.readdirSync(claudeProjectsDir);
      const matchDir = projectDirs.find((d) => d.includes(`issue-${issueNumber}`) || d === sanitizedPath);

      if (matchDir) {
        const fullMatchPath = path.join(claudeProjectsDir, matchDir);
        const files = fs.readdirSync(fullMatchPath).filter((f) => f.endsWith('.jsonl'));
        if (files.length > 0) {
          const stats = files.map((f) => ({
            file: f,
            mtime: fs.statSync(path.join(fullMatchPath, f)).mtimeMs,
          }));
          stats.sort((a, b) => b.mtime - a.mtime);
          const latestJsonl = path.join(fullMatchPath, stats[0].file);

          const content = fs.readFileSync(latestJsonl, 'utf8');
          const lines = content.split('\n').filter(Boolean);
          const recentLines = lines.slice(-MAX_TRANSCRIPT_LINES);

          for (const line of recentLines) {
            try {
              const parsed = JSON.parse(line);
              const timeStr = parsed.timestamp
                ? new Date(parsed.timestamp).toLocaleTimeString()
                : new Date().toLocaleTimeString();

              for (const evt of parseClaudeTranscriptEntry(parsed)) {
                events.push({
                  id: `hist-${events.length}-${Math.random().toString(36).slice(2, 6)}`,
                  issueNumber,
                  timestamp: timeStr,
                  ...evt,
                });
              }
            } catch {}
          }
        }
      }
    }
  } catch {}

  // 1b. Check Antigravity (agy) transcripts in ~/.gemini/antigravity-cli/brain/
  if (events.length === 0) {
    try {
      const brainDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');
      if (fs.existsSync(brainDir)) {
        const entries = fs.readdirSync(brainDir, { withFileTypes: true });
        const dirStats: { transcriptPath: string; mtime: number }[] = [];

        for (const entry of entries) {
          if (entry.isDirectory()) {
            const transcriptPath = path.join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
            if (fs.existsSync(transcriptPath)) {
              try {
                const stat = fs.statSync(transcriptPath);
                dirStats.push({ transcriptPath, mtime: stat.mtimeMs });
              } catch {}
            }
          }
        }

        dirStats.sort((a, b) => b.mtime - a.mtime);

        // Strictly check if candidate transcript belongs to this issue or worktree
        let matchedTranscript: string | undefined;
        for (const candidate of dirStats.slice(0, 10)) {
          try {
            const head = fs.readFileSync(candidate.transcriptPath, 'utf8').slice(0, 10000);
            if (
              head.includes(`issues/${issueNumber}`) ||
              head.includes(`issue-${issueNumber}`) ||
              head.includes(`Issue #${issueNumber}`) ||
              head.includes(`Closes #${issueNumber}`) ||
              head.includes(path.basename(targetWorktree))
            ) {
              matchedTranscript = candidate.transcriptPath;
              break;
            }
          } catch {}
        }

        if (matchedTranscript) {
          const content = fs.readFileSync(matchedTranscript, 'utf8');
          const lines = content.split('\n').filter(Boolean);
          const recentLines = lines.slice(-MAX_TRANSCRIPT_LINES);

          for (const line of recentLines) {
            try {
              const parsed = JSON.parse(line);
              const timeStr = parsed.created_at
                ? new Date(parsed.created_at).toLocaleTimeString()
                : new Date().toLocaleTimeString();

              if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
                for (const tc of parsed.tool_calls) {
                  const summary = tc.args?.toolSummary || tc.args?.toolAction || '';
                  const cmd = tc.args?.CommandLine ? `\`${tc.args.CommandLine.slice(0, 50)}\`` : '';
                  const target = tc.args?.TargetFile ? path.basename(tc.args.TargetFile) : '';
                  const detail = summary || cmd || target || tc.name;
                  events.push({
                    id: `hist-agy-${events.length}-${Math.random().toString(36).slice(2, 6)}`,
                    issueNumber,
                    type: 'tool_start',
                    timestamp: timeStr,
                    summary: `🔧 ${tc.name}: ${detail}`,
                    detail: tc.args,
                  });
                }
              } else if (parsed.type === 'PLANNER_RESPONSE' && parsed.content) {
                const thought = parsed.content.trim();
                if (thought) {
                  events.push({
                    id: `hist-agy-${events.length}-${Math.random().toString(36).slice(2, 6)}`,
                    issueNumber,
                    type: 'thought',
                    timestamp: timeStr,
                    summary: thought,
                  });
                }
              } else if (parsed.type === 'GENERIC' || (parsed.source === 'MODEL' && parsed.content)) {
                const firstLine = (parsed.content || '').split('\n')[0] || '';
                if (firstLine && !firstLine.startsWith('{')) {
                  events.push({
                    id: `hist-agy-${events.length}-${Math.random().toString(36).slice(2, 6)}`,
                    issueNumber,
                    type: 'tool_end',
                    timestamp: timeStr,
                    summary: `✓ ${firstLine.slice(0, 80)}`,
                    detail: { content: parsed.content },
                  });
                }
              }
            } catch {}
          }
        }
      }
    } catch {}
  }

  // 2. If no JSONL events or few events found, inspect session timeline and stdout from state
  if (events.length === 0) {
    if (session.metadata?.timeline && session.metadata.timeline.length > 0) {
      for (const item of session.metadata.timeline) {
        const timeStr = item.timestamp ? new Date(item.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
        events.push({
          id: `hist-stage-${events.length}`,
          issueNumber,
          type: item.stage === 'PROMPT_INJECTED' ? 'prompt_injected' : 'info',
          timestamp: timeStr,
          summary: `[${item.stage}] ${item.message || ''}`,
        });
      }
    }

    if (session.stdout) {
      const stdoutLines = session.stdout.split('\n').filter((l) => l.trim().length > 0).slice(-MAX_TRANSCRIPT_LINES);
      for (const line of stdoutLines) {
        events.push({
          id: `hist-stdout-${events.length}`,
          issueNumber,
          type: 'stdout',
          timestamp: new Date().toLocaleTimeString(),
          summary: line.trim(),
        });
      }
    }
  }

  // 3. If worktree is paused, add an informative notice at the end if not already present
  if (session.metadata?.status === 'paused_quota') {
    events.push({
      id: `hist-notice-${Date.now()}`,
      issueNumber,
      type: 'info',
      timestamp: new Date().toLocaleTimeString(),
      summary: 'Task execution is paused due to 5h quota limits. Worktree is preserved and will auto-resume.',
    });
  }

  // Prepopulate event bus history
  if (events.length > 0) {
    for (const evt of events) {
      eventBus.emitAgentEvent(evt);
    }
  }

  return events;
}
