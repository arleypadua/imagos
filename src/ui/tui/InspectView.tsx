import React from 'react';
import { Box, Text, useStdout } from 'ink';
import wrapAnsi from 'wrap-ansi';
import type { AgentEvent } from '../../events/bus.js';
import type { WorkerItem } from './MasterDashboard.js';

interface InspectViewProps {
  worker: WorkerItem;
  events: AgentEvent[];
  inputText: string;
  isSubmitting: boolean;
  statusMessage?: string;
  /** First visible line; `null` follows the tail of the stream. */
  scrollTop?: number | null;
  /** Show tool results in full instead of collapsed previews. */
  expanded?: boolean;
}

export interface InspectLine {
  gutter: string;
  text: string;
  color: string;
  bold?: boolean;
  dim?: boolean;
}

interface LogicalLine {
  text: string;
  color: string;
  bold?: boolean;
  dim?: boolean;
}

// Tool outputs (file reads, grep hits, test logs) are mostly noise; preview them and let Tab expand.
const COLLAPSED_RESULT_LINES = 12;

// Rows taken by the header banner, section title, prompt box, footer and margins.
const CHROME_ROWS = 14;
const MIN_VIEWPORT_ROWS = 6;

export function getInspectViewport(columns?: number, rows?: number): { width: number; height: number } {
  const width = Math.max(40, (columns || 100) - 2);
  const height = Math.max(MIN_VIEWPORT_ROWS, (rows || 30) - CHROME_ROWS);
  return { width, height };
}

const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;

function sanitize(text: string): string {
  return text
    .replace(ANSI_PATTERN, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

function splitLines(text: string): string[] {
  const lines = sanitize(text).split('\n');
  while (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
}

/** Light markdown prettifying for agent prose: headings/bold become bold lines, bullets become dots. */
function markdownLines(text: string, color: string): LogicalLine[] {
  let inFence = false;
  return splitLines(text).map((raw) => {
    if (raw.trim().startsWith('```')) {
      inFence = !inFence;
      return { text: raw, color: 'gray', dim: true };
    }
    if (inFence) return { text: raw, color: 'cyan' };

    const heading = raw.match(/^#{1,6}\s+(.*)$/);
    if (heading) return { text: heading[1], color, bold: true };

    const bold = /^\s*\*\*/.test(raw);
    const line = raw.replace(/^(\s*)[-*]\s+/, '$1• ').replace(/\*\*(.+?)\*\*/g, '$1');
    return { text: line, color, bold };
  });
}

function block(lines: string[], color: string, prefix = '', dim = false): LogicalLine[] {
  return lines.map((l) => ({ text: `${prefix}${l}`, color, dim }));
}

function diffLines(oldStr: unknown, newStr: unknown): LogicalLine[] {
  const out: LogicalLine[] = [];
  if (typeof oldStr === 'string' && oldStr.length > 0) out.push(...block(splitLines(oldStr), 'red', '- '));
  if (typeof newStr === 'string' && newStr.length > 0) out.push(...block(splitLines(newStr), 'green', '+ '));
  return out;
}

function prettyJson(value: unknown): string[] {
  try {
    return splitLines(JSON.stringify(value, null, 2));
  } catch {
    return [String(value)];
  }
}

function formatToolStart(event: AgentEvent): LogicalLine[] {
  const name: string | undefined = event.detail?.name;
  const input = event.detail?.input;
  if (!name || !input || typeof input !== 'object') {
    return markdownLines(event.summary, 'cyan');
  }

  const header = (hint?: string): LogicalLine => ({
    text: `🔧 ${name}${hint ? `  ${sanitize(hint)}` : ''}`,
    color: 'cyan',
    bold: true,
  });

  switch (name) {
    case 'Bash':
      return [
        header(input.description),
        ...splitLines(String(input.command ?? '')).map((l, i) => ({ text: `${i === 0 ? '$ ' : '  '}${l}`, color: 'white' })),
      ];
    case 'Read': {
      const range = input.offset || input.limit ? ` (from line ${input.offset ?? 1}${input.limit ? `, ${input.limit} lines` : ''})` : '';
      return [header(`${input.file_path ?? ''}${range}`)];
    }
    case 'Edit':
      return [
        header(`${input.file_path ?? ''}${input.replace_all ? '  (replace all)' : ''}`),
        ...diffLines(input.old_string, input.new_string),
      ];
    case 'MultiEdit': {
      const edits: any[] = Array.isArray(input.edits) ? input.edits : [];
      const out: LogicalLine[] = [header(`${input.file_path ?? ''}  (${edits.length} edits)`)];
      edits.forEach((edit, i) => {
        out.push({ text: `@@ edit ${i + 1}`, color: 'gray', dim: true });
        out.push(...diffLines(edit?.old_string, edit?.new_string));
      });
      return out;
    }
    case 'Write':
      return [header(input.file_path), ...diffLines(undefined, input.content)];
    case 'Grep':
      return [header(`/${input.pattern ?? ''}/${input.path ? ` in ${input.path}` : ''}${input.glob ? ` (${input.glob})` : ''}`)];
    case 'Glob':
      return [header(`${input.pattern ?? ''}${input.path ? ` in ${input.path}` : ''}`)];
    case 'WebFetch':
      return [header(input.url), ...(input.prompt ? block(splitLines(String(input.prompt)), 'white', '', true) : [])];
    case 'WebSearch':
      return [header(input.query)];
    case 'TodoWrite': {
      const todos: any[] = Array.isArray(input.todos) ? input.todos : [];
      const icon = (status: string) => (status === 'completed' ? '☑' : status === 'in_progress' ? '◐' : '☐');
      return [
        header(),
        ...todos.map((t) => ({
          text: `${icon(t?.status)} ${sanitize(String(t?.content ?? ''))}`,
          color: t?.status === 'completed' ? 'green' : t?.status === 'in_progress' ? 'yellow' : 'white',
        })),
      ];
    }
    case 'Task':
    case 'Agent':
      return [header(input.description), ...markdownLines(String(input.prompt ?? ''), 'white')];
    default:
      return [header(), ...block(prettyJson(input), 'white', '', true)];
  }
}

function formatToolEnd(event: AgentEvent, toolNames: Map<string, string>, expanded: boolean): LogicalLine[] {
  const content = event.detail?.content;
  if (typeof content !== 'string') {
    return [{ text: event.summary, color: 'green' }];
  }

  const isError = !!event.detail?.isError;
  const toolName = event.detail?.toolUseId ? toolNames.get(event.detail.toolUseId) : undefined;
  const label = `${isError ? '✗' : '✓'} ${toolName ? `${toolName} ` : ''}${isError ? 'error' : 'result'}`;
  const lines = content.trim() ? splitLines(content) : [];
  if (lines.length === 0) {
    return [{ text: `${label} (no output)`, color: isError ? 'red' : 'green' }];
  }

  const visible = expanded ? lines : lines.slice(0, COLLAPSED_RESULT_LINES);
  const out: LogicalLine[] = [
    { text: `${label} (${lines.length} line${lines.length === 1 ? '' : 's'})`, color: isError ? 'red' : 'green' },
    ...block(visible, isError ? 'red' : 'gray', '│ '),
  ];
  if (visible.length < lines.length) {
    out.push({ text: `└ … ${lines.length - visible.length} more lines (Tab to expand)`, color: 'gray', dim: true });
  }
  return out;
}

function formatEvent(event: AgentEvent, toolNames: Map<string, string>, expanded: boolean): LogicalLine[] {
  switch (event.type) {
    case 'tool_start':
      return formatToolStart(event);
    case 'tool_end':
      return formatToolEnd(event, toolNames, expanded);
    case 'thought': {
      const lines = markdownLines(event.summary, 'yellow');
      if (lines.length > 0) lines[0] = { ...lines[0], text: `💬 ${lines[0].text}` };
      return lines;
    }
    case 'prompt_injected':
      return markdownLines(`💡 ${event.summary}`, 'magenta').map((l) => ({ ...l, bold: true }));
    case 'stderr':
      return block(splitLines(`⚠️ ${event.summary}`), 'red');
    case 'info':
      return block(splitLines(`ℹ️ ${event.summary}`), 'blue');
    case 'stdout':
    default:
      return markdownLines(event.summary, 'white');
  }
}

let cache: { events: AgentEvent[]; length: number; lastId?: string; width: number; expanded: boolean; lines: InspectLine[] } | undefined;

/** Flattens events into terminal-width rows so the viewport can scroll line by line. */
export function buildInspectLines(events: AgentEvent[], width: number, expanded: boolean): InspectLine[] {
  const lastId = events[events.length - 1]?.id;
  if (
    cache &&
    cache.events === events &&
    cache.length === events.length &&
    cache.lastId === lastId &&
    cache.width === width &&
    cache.expanded === expanded
  ) {
    return cache.lines;
  }

  const toolNames = new Map<string, string>();
  for (const e of events) {
    if (e.type === 'tool_start' && e.detail?.toolUseId && e.detail?.name) {
      toolNames.set(e.detail.toolUseId, e.detail.name);
    }
  }

  const lines: InspectLine[] = [];
  for (const event of events) {
    const stamp = `[${event.timestamp}] `;
    const indent = ' '.repeat(stamp.length);
    const contentWidth = Math.max(10, width - stamp.length);
    let first = true;
    for (const logical of formatEvent(event, toolNames, expanded)) {
      const wrapped = logical.text === '' ? [''] : wrapAnsi(logical.text, contentWidth, { hard: true, trim: false }).split('\n');
      for (const row of wrapped) {
        lines.push({ gutter: first ? stamp : indent, text: row, color: logical.color, bold: logical.bold, dim: logical.dim });
        first = false;
      }
    }
  }

  cache = { events, length: events.length, lastId, width, expanded, lines };
  return lines;
}

export function clampScrollTop(scrollTop: number | null, totalLines: number, height: number): number {
  const maxTop = Math.max(0, totalLines - height);
  if (scrollTop === null) return maxTop;
  return Math.min(maxTop, Math.max(0, scrollTop));
}

export const InspectView: React.FC<InspectViewProps> = ({
  worker,
  events,
  inputText,
  isSubmitting,
  statusMessage,
  scrollTop = null,
  expanded = false,
}) => {
  const { stdout } = useStdout();
  const { width, height } = getInspectViewport(stdout?.columns, stdout?.rows);
  const lines = buildInspectLines(events, width, expanded);
  const top = clampScrollTop(scrollTop, lines.length, height);
  const visible = lines.slice(top, top + height);
  const following = scrollTop === null || top >= Math.max(0, lines.length - height);

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      {/* Header Banner */}
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
        <Box flexDirection="row">
          <Text backgroundColor="cyan" color="black" bold>
            {` ⚡ LIVE TAIL: Issue #${worker.issueNumber} `}
          </Text>
          <Text bold color="white" wrap="truncate">
            {' '}{worker.title}
          </Text>
        </Box>
        <Box flexDirection="row" marginTop={0}>
          <Text color="gray">Branch: </Text>
          <Text color="white">{worker.branchName}  </Text>
          <Text color="gray">Status: </Text>
          <Text color="cyan">{worker.status}  </Text>
        </Box>
      </Box>

      {/* Scrollable Activity Stream Viewport */}
      <Box flexDirection="row">
        <Text bold color="white">
          Agent Activity &amp; Tool Calls:
        </Text>
        {lines.length > 0 && (
          <Text color="gray">
            {`  lines ${top + 1}-${Math.min(lines.length, top + height)} of ${lines.length}`}
            {following ? '  • following' : '  • paused (End to follow)'}
            {expanded ? '  • outputs expanded' : ''}
          </Text>
        )}
      </Box>
      <Box flexDirection="column" height={height} marginBottom={1}>
        {lines.length === 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {worker.status === 'paused_quota' || worker.isWip ? (
              <>
                <Text color="yellow">  ⏳ Task execution is paused awaiting 5-hour quota reset (preserves WIP).</Text>
                <Text color="gray">  Worktree state &amp; code changes are intact. You can inject prompt guidance below.</Text>
              </>
            ) : (
              <Text color="gray">  Agent is initializing context and analyzing task...</Text>
            )}
          </Box>
        ) : (
          visible.map((line, i) => (
            <Box key={top + i} flexDirection="row">
              <Text color="gray">{line.gutter}</Text>
              <Text color={line.color} bold={line.bold} dimColor={line.dim} wrap="truncate">
                {line.text}
              </Text>
            </Box>
          ))
        )}
      </Box>

      {/* Prompt Injection Input Bar */}
      <Box flexDirection="column" borderStyle="single" borderColor={isSubmitting ? 'yellow' : 'cyan'} paddingX={1} marginBottom={1}>
        <Box flexDirection="row">
          <Text bold color="cyan">
            {'❯ Inject prompt: '}
          </Text>
          <Text color="white">
            {inputText}
          </Text>
          <Text color="cyan" bold>
            _
          </Text>
        </Box>
        {statusMessage && (
          <Box marginTop={0}>
            <Text color="yellow">{statusMessage}</Text>
          </Box>
        )}
      </Box>

      {/* Footer Navigation Hints */}
      <Box paddingX={1}>
        <Text color="gray" wrap="truncate">
          [Esc] Back to Overview  •  [Enter] Send  •  [↑↓ PgUp PgDn] Scroll  •  [Home/End] Top/Follow  •  [Tab] {expanded ? 'Collapse' : 'Expand'}
        </Text>
      </Box>
    </Box>
  );
};
