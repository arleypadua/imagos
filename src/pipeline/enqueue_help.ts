export interface ParsedEnqueueArgs {
  issueNumber?: number;
  force: boolean;
  now: boolean;
  runner?: string;
  unknownFlags: string[];
}

export const ENQUEUE_ALIASES = ['/run', '/dispatch', '/force-run'];

export const ENQUEUE_USAGE = '/enqueue <issue> [--now] [--runner <name>] [--force]';

export const ENQUEUE_SUMMARY =
  'Puts an issue at the front of the priority queue, ahead of the scheduling order.';

export const ENQUEUE_FLAGS: Array<{ flag: string; alias: string; description: string }> = [
  {
    flag: '--now',
    alias: '-n',
    description:
      'Start on an extra worker slot, past the concurrency ceiling. The slot is given back when the task ends.',
  },
  {
    flag: '--runner <name>',
    alias: '-r',
    description:
      'Dispatch to a named runner instead of the one the issue labels and config choose.',
  },
  {
    flag: '--force',
    alias: '-f',
    description: 'Skip the confirmation for a closed issue, a spec, or open blockers.',
  },
];

export const ENQUEUE_EXAMPLES = [
  '/enqueue 47',
  '/enqueue 47 --now',
  '/enqueue 47 --runner agy',
  '/enqueue 47 --now --runner agy --force',
];

/**
 * Shared by the TUI command palette and the Telegram bot so a flag never means two different
 * things depending on which surface typed it.
 */
export function parseEnqueueArgs(args: string[]): ParsedEnqueueArgs {
  const parsed: ParsedEnqueueArgs = { force: false, now: false, unknownFlags: [] };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i].trim();
    if (!arg) continue;

    if (arg === '--force' || arg === '-f') {
      parsed.force = true;
    } else if (arg === '--now' || arg === '-n') {
      parsed.now = true;
    } else if (arg === '--runner' || arg === '-r') {
      const value = args[i + 1]?.trim();
      if (value && !value.startsWith('-')) {
        parsed.runner = value.toLowerCase();
        i++;
      } else {
        parsed.unknownFlags.push(`${arg} (missing runner name)`);
      }
    } else if (arg.startsWith('--runner=')) {
      const value = arg.slice('--runner='.length).trim();
      if (value) {
        parsed.runner = value.toLowerCase();
      } else {
        parsed.unknownFlags.push('--runner= (missing runner name)');
      }
    } else if (arg.startsWith('-')) {
      parsed.unknownFlags.push(arg);
    } else if (parsed.issueNumber === undefined) {
      const issueNumber = parseInt(arg.replace(/^#/, ''), 10);
      if (!Number.isNaN(issueNumber)) {
        parsed.issueNumber = issueNumber;
      }
    }
  }

  return parsed;
}

export function formatEnqueueFlagLines(bullet = '•', markdown = true): string[] {
  const code = (text: string) => (markdown ? `\`${text}\`` : text);
  return ENQUEUE_FLAGS.map(
    (f) => `${bullet} ${code(f.flag)} (${code(f.alias)}) — ${f.description}`
  );
}
