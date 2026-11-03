import type { InteractiveAction, IssueLinks, IssueRunState } from './types.js';

/**
 * Callback data for the inline keyboards that let a person move between views (`v1:n:`), act on an
 * issue or the daemon (`v1:a:`) and change usage limits (`v1:l:`). Telegram caps callback data at 64 bytes,
 * so every payload stays short.
 */
export const NAV_PREFIX = 'v1:n:';
export const ACTION_PREFIX = 'v1:a:';
export const LIMIT_PREFIX = 'v1:l:';

export type NavView = 'menu' | 'status' | 'tasks' | 'specs' | 'help' | 'limits' | 'inspect' | 'logs' | 'steer' | 'browse';

export type NavTarget =
  | { view: 'menu' | 'status' | 'tasks' | 'specs' | 'help' | 'limits' | 'steer' }
  | { view: 'inspect' | 'logs'; issueNumber?: number }
  | { view: 'browse'; page: number };

const SIMPLE_VIEWS = ['menu', 'status', 'tasks', 'specs', 'help', 'limits', 'steer'] as const;

export function buildNavCallbackData(target: NavTarget): string {
  if (target.view === 'inspect' || target.view === 'logs') {
    return target.issueNumber !== undefined
      ? `${NAV_PREFIX}${target.view}:${target.issueNumber}`
      : `${NAV_PREFIX}${target.view}`;
  }
  if (target.view === 'browse') {
    return `${NAV_PREFIX}browse:${target.page}`;
  }
  return `${NAV_PREFIX}${target.view}`;
}

export function parseNavCallbackData(payload: string): NavTarget | null {
  if (!payload || !payload.startsWith(NAV_PREFIX)) return null;
  const [view, arg] = payload.slice(NAV_PREFIX.length).split(':');
  if ((SIMPLE_VIEWS as readonly string[]).includes(view)) {
    return { view: view as (typeof SIMPLE_VIEWS)[number] };
  }
  if (view === 'inspect' || view === 'logs') {
    if (arg === undefined || arg === '') return { view };
    const issueNumber = parseInt(arg, 10);
    return isNaN(issueNumber) ? null : { view, issueNumber };
  }
  if (view === 'browse') {
    const page = parseInt(arg ?? '1', 10);
    return { view, page: isNaN(page) || page < 1 ? 1 : page };
  }
  return null;
}

export type IssueActionKind = 'steer' | 'enqueue' | 'now' | 'pause' | 'resume';
export type DaemonActionKind = 'dpause' | 'dresume' | 'qresume' | 'clean';

export type ActionTarget =
  | { action: IssueActionKind; issueNumber: number }
  | { action: DaemonActionKind };

const ISSUE_ACTIONS: IssueActionKind[] = ['steer', 'enqueue', 'now', 'pause', 'resume'];
const DAEMON_ACTIONS: DaemonActionKind[] = ['dpause', 'dresume', 'qresume', 'clean'];

export function buildActionCallbackData(target: ActionTarget): string {
  return 'issueNumber' in target
    ? `${ACTION_PREFIX}${target.action}:${target.issueNumber}`
    : `${ACTION_PREFIX}${target.action}`;
}

export function parseActionCallbackData(payload: string): ActionTarget | null {
  if (!payload || !payload.startsWith(ACTION_PREFIX)) return null;
  const [action, arg] = payload.slice(ACTION_PREFIX.length).split(':');
  if ((DAEMON_ACTIONS as string[]).includes(action)) {
    return { action: action as DaemonActionKind };
  }
  if ((ISSUE_ACTIONS as string[]).includes(action)) {
    const issueNumber = parseInt(arg ?? '', 10);
    return isNaN(issueNumber) ? null : { action: action as IssueActionKind, issueNumber };
  }
  return null;
}

export type LimitWindow = 'h' | 'w';

/** `v1:l:h:85` sets the 5h limit to 85%, `v1:l:w:90` the weekly limit to 90%. */
export function buildLimitCallbackData(window: LimitWindow, percent: number): string {
  return `${LIMIT_PREFIX}${window}:${Math.round(percent)}`;
}

export function parseLimitCallbackData(payload: string): { window: LimitWindow; percent: number } | null {
  if (!payload || !payload.startsWith(LIMIT_PREFIX)) return null;
  const [window, arg] = payload.slice(LIMIT_PREFIX.length).split(':');
  const percent = parseInt(arg ?? '', 10);
  if ((window !== 'h' && window !== 'w') || isNaN(percent) || percent < 1 || percent > 100) return null;
  return { window, percent };
}

/**
 * Parses `/limits` arguments: `weekly 90`, `5h 85`, `w=90 h=80`, `weekly 90%`. Keys may be `5h`, `h`,
 * `session` or `week`, `weekly`, `w`.
 */
export function parseLimitArgs(args: string[]): { fiveHourPercent?: number; weeklyPercent?: number; error?: string } {
  const tokens = args.flatMap((a) => a.split('=')).map((t) => t.trim()).filter(Boolean);
  const result: { fiveHourPercent?: number; weeklyPercent?: number; error?: string } = {};
  for (let i = 0; i < tokens.length; i += 2) {
    const key = tokens[i].toLowerCase().replace(/^--/, '');
    const raw = tokens[i + 1];
    const value = raw === undefined ? NaN : parseFloat(raw.replace(/%$/, ''));
    const percent = value > 0 && value <= 1 && raw?.includes('.') ? Math.round(value * 100) : Math.round(value);
    if (isNaN(percent) || percent < 1 || percent > 100) {
      return { error: `Limit for \`${tokens[i]}\` must be a percentage between 1 and 100.` };
    }
    if (['5h', 'h', 'session', 'five-hour', 'fivehour', '5-hour'].includes(key)) {
      result.fiveHourPercent = percent;
    } else if (['w', 'week', 'weekly'].includes(key)) {
      result.weeklyPercent = percent;
    } else {
      return { error: `Unknown limit \`${tokens[i]}\`. Use \`5h\` or \`weekly\`.` };
    }
  }
  return result;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function navButton(label: string, target: NavTarget): InteractiveAction {
  const payload = buildNavCallbackData(target);
  return { id: payload, label, payload };
}

export function actionButton(label: string, target: ActionTarget): InteractiveAction {
  const payload = buildActionCallbackData(target);
  return { id: payload, label, payload };
}

export function urlButton(label: string, url: string): InteractiveAction {
  return { id: `url:${url}`, label, payload: '', url };
}

/** A row of link buttons to an issue and, when there is one, its pull request. Empty when there is no link. */
export function buildLinkRow(issueNumber: number, links?: IssueLinks): InteractiveAction[] {
  const row: InteractiveAction[] = [];
  if (links?.issueUrl) {
    row.push(urlButton(`🔗 Issue #${issueNumber}`, links.issueUrl));
  }
  if (links?.prUrl) {
    const state = links.prState && links.prState !== 'OPEN' ? ` (${links.prState.toLowerCase()})` : '';
    row.push(urlButton(`🔀 PR${links.prNumber ? ` #${links.prNumber}` : ''}${state}`, links.prUrl));
  }
  return row;
}

/** The footer every view ends with: a way back to where the person came from and to the main menu. */
export function buildFooterRow(options: { back?: NavTarget; refresh?: NavTarget } = {}): InteractiveAction[] {
  const row: InteractiveAction[] = [];
  if (options.back && options.back.view !== 'menu') row.push(navButton('⬅️ Back', options.back));
  if (options.refresh) row.push(navButton('🔄 Refresh', options.refresh));
  row.push(navButton('🏠 Menu', { view: 'menu' }));
  return row;
}

export function buildMainMenuRows(): InteractiveAction[][] {
  return [
    [navButton('📊 Status', { view: 'status' }), navButton('📋 Tasks', { view: 'tasks' })],
    [navButton('📚 Issues', { view: 'browse', page: 1 }), navButton('🎯 Specs', { view: 'specs' })],
    [navButton('🔍 Inspect', { view: 'inspect' }), navButton('📜 Logs', { view: 'logs' })],
    [navButton('🧭 Steer', { view: 'steer' }), navButton('⚙️ Limits', { view: 'limits' })],
    [navButton('❓ Help', { view: 'help' })],
  ];
}

export interface PickerItem {
  issueNumber: number;
  title?: string;
  state?: string;
}

const STATE_ICONS: Record<string, string> = { running: '▶️', paused: '⏸️', queued: '⏳' };

/**
 * One button per issue that opens it in the given view, or for `steer` asks for instructions. Capped so the
 * keyboard stays usable on a phone.
 */
export function buildIssuePickerRows(
  items: PickerItem[],
  view: 'inspect' | 'logs' | 'steer',
  max: number = 8
): InteractiveAction[][] {
  const seen = new Set<number>();
  const rows: InteractiveAction[][] = [];
  for (const item of items) {
    if (seen.has(item.issueNumber) || rows.length >= max) continue;
    seen.add(item.issueNumber);
    const icon = (item.state && STATE_ICONS[item.state]) || '•';
    const title = item.title ? ` ${truncate(item.title, 28)}` : '';
    const label = `${icon} #${item.issueNumber}${title}`;
    rows.push([
      view === 'steer'
        ? actionButton(label, { action: 'steer', issueNumber: item.issueNumber })
        : navButton(label, { view, issueNumber: item.issueNumber }),
    ]);
  }
  return rows;
}

/** Compact rows of `#N` buttons that open each issue's inspect view. */
export function buildIssueNumberRows(issueNumbers: number[], perRow: number = 5): InteractiveAction[][] {
  const rows: InteractiveAction[][] = [];
  for (let i = 0; i < issueNumbers.length; i += perRow) {
    rows.push(
      issueNumbers
        .slice(i, i + perRow)
        .map((n) => navButton(`#${n}`, { view: 'inspect', issueNumber: n }))
    );
  }
  return rows;
}

/** The controls that fit an issue where it stands: steer or pause a running one, resume a paused one, run a queued one. */
export function buildIssueControlRows(
  issueNumber: number,
  state: IssueRunState | undefined,
  current: 'inspect' | 'logs' | 'other'
): InteractiveAction[][] {
  const viewRow: InteractiveAction[] = [];
  if (current !== 'inspect') viewRow.push(navButton('🔍 Inspect', { view: 'inspect', issueNumber }));
  if (current !== 'logs') viewRow.push(navButton('📜 Logs', { view: 'logs', issueNumber }));

  const actRow: InteractiveAction[] = [];
  if (state === 'running') {
    actRow.push(actionButton('🧭 Steer', { action: 'steer', issueNumber }));
    actRow.push(actionButton('⏸️ Pause', { action: 'pause', issueNumber }));
  } else if (state === 'paused') {
    actRow.push(actionButton('▶️ Resume', { action: 'resume', issueNumber }));
    actRow.push(actionButton('🧭 Steer', { action: 'steer', issueNumber }));
  } else if (state === 'queued') {
    actRow.push(actionButton('⚡ Run now', { action: 'now', issueNumber }));
  } else {
    actRow.push(actionButton('➕ Enqueue', { action: 'enqueue', issueNumber }));
    actRow.push(actionButton('⚡ Run now', { action: 'now', issueNumber }));
  }

  return [viewRow, actRow].filter((r) => r.length > 0);
}

/** −5/+5 buttons for each limit, kept within 5%–100%. */
export function buildLimitAdjustRows(fiveHourPercent: number, weeklyPercent: number): InteractiveAction[][] {
  const button = (window: LimitWindow, label: string, percent: number): InteractiveAction => {
    const payload = buildLimitCallbackData(window, percent);
    return { id: payload, label, payload };
  };
  const clamp = (n: number) => Math.min(100, Math.max(5, n));
  const row = (window: LimitWindow, name: string, current: number): InteractiveAction[] => {
    const buttons: InteractiveAction[] = [];
    if (current > 5) buttons.push(button(window, `${name} −5% → ${clamp(current - 5)}%`, clamp(current - 5)));
    if (current < 100) buttons.push(button(window, `${name} +5% → ${clamp(current + 5)}%`, clamp(current + 5)));
    return buttons;
  };
  return [row('h', '5h', fiveHourPercent), row('w', 'Weekly', weeklyPercent)].filter((r) => r.length > 0);
}
