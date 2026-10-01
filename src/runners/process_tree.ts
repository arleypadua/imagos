import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';

// Agents are spawned as process-group leaders so everything their tools start (dev servers, watchers,
// background jobs) can be signalled together. Without it those outlive the agent and pile up across rounds.
export const SPAWN_DETACHED = process.platform !== 'win32';

const DEFAULT_GRACE_MS = 3000;
const POLL_MS = 100;

const liveGroups = new Set<number>();
let exitHookInstalled = false;

// A detached group does not die with the daemon, so an exit that skips the per-run reap must not orphan it.
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const pgid of liveGroups) {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {}
    }
  });
}

export function trackProcessGroup(pid: number): void {
  if (!SPAWN_DETACHED) return;
  installExitHook();
  liveGroups.add(pid);
}

// Signals the whole group led by pid, falling back to the process alone when it leads no group.
export function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  if (SPAWN_DETACHED) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {}
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function isAlive(id: number): boolean {
  try {
    process.kill(id, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntilGone(ids: number[], graceMs: number): Promise<number[]> {
  const deadline = Date.now() + graceMs;
  let remaining = ids.filter(isAlive);
  while (remaining.length > 0 && Date.now() < deadline) {
    await sleep(POLL_MS);
    remaining = remaining.filter(isAlive);
  }
  return remaining;
}

// SIGTERM the group, then SIGKILL whatever is left after the grace period. The group id cannot be reused
// while any member is alive, so signalling it after the leader exited only reaches its own leftovers.
export async function killProcessGroup(pgid: number, graceMs: number = DEFAULT_GRACE_MS): Promise<void> {
  liveGroups.delete(pgid);
  if (!SPAWN_DETACHED) return;
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch {
    return;
  }
  // A group frozen by a quota pause cannot act on SIGTERM until it is continued.
  try {
    process.kill(-pgid, 'SIGCONT');
  } catch {}
  const left = await waitUntilGone([-pgid], graceMs);
  if (left.length > 0) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {}
  }
}

function resolveDir(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

function isWithin(child: string, dir: string): boolean {
  return child === dir || child.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

async function listOrphanPids(): Promise<number[]> {
  const { stdout } = await execa('ps', ['-A', '-o', 'pid=,ppid='], { reject: false });
  const orphans: number[] = [];
  for (const line of (stdout || '').split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid > 1 && ppid === 1 && pid !== process.pid) orphans.push(pid);
  }
  return orphans;
}

async function readCwds(pids: number[]): Promise<Map<number, string>> {
  const cwds = new Map<number, string>();
  if (pids.length === 0) return cwds;

  if (process.platform === 'linux') {
    for (const pid of pids) {
      try {
        cwds.set(pid, fs.readlinkSync(`/proc/${pid}/cwd`));
      } catch {}
    }
    return cwds;
  }

  const { stdout } = await execa('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')], { reject: false });
  let current: number | undefined;
  for (const line of (stdout || '').split('\n')) {
    if (line.startsWith('p')) current = Number(line.slice(1));
    else if (line.startsWith('n') && current !== undefined) cwds.set(current, line.slice(1));
  }
  return cwds;
}

// Finds processes that escaped their agent's group (setsid, daemonized servers) and were reparented to
// init, by their working directory being inside dir. Restricting to orphans keeps a developer's own shell
// or editor that happens to sit in the worktree out of reach.
export async function findOrphansInDir(dir: string): Promise<number[]> {
  if (process.platform === 'win32') return [];
  try {
    const target = resolveDir(dir);
    const cwds = await readCwds(await listOrphanPids());
    return Array.from(cwds.entries())
      .filter(([, cwd]) => isWithin(cwd, target))
      .map(([pid]) => pid);
  } catch {
    return [];
  }
}

export async function killOrphansInDir(dir: string, graceMs: number = DEFAULT_GRACE_MS): Promise<number[]> {
  const pids = await findOrphansInDir(dir);
  if (pids.length === 0) return [];
  for (const pid of pids) {
    signalProcessGroup(pid, 'SIGTERM');
  }
  const left = await waitUntilGone(pids, graceMs);
  for (const pid of left) {
    signalProcessGroup(pid, 'SIGKILL');
  }
  return pids;
}

// Everything an agent round started is dead weight once the agent exits: the next round is a fresh process.
export async function reapAgentProcesses(pid: number | undefined, cwd: string): Promise<void> {
  if (pid) await killProcessGroup(pid);
  await killOrphansInDir(cwd);
}
