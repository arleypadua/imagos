import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { execa } from 'execa';
import { findOrphansInDir, killOrphansInDir, killProcessGroup, reapAgentProcesses } from '../src/runners/process_tree.js';

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
};

const waitFor = async (check: () => boolean, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
};

const readPid = async (file: string) => {
  await waitFor(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() !== '');
  return Number(fs.readFileSync(file, 'utf8').trim());
};

describe.skipIf(process.platform === 'win32')('process tree cleanup', () => {
  const spawned: number[] = [];
  let tmp: string;

  afterEach(() => {
    for (const pid of spawned.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('kills the background processes an agent left in its group after the agent exited', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imagos-tree-'));
    const pidFile = path.join(tmp, 'child.pid');
    const agent = execa('sh', ['-c', `sleep 60 >/dev/null 2>&1 & echo $! > ${pidFile}`], { detached: true });
    await agent;
    const child = await readPid(pidFile);
    spawned.push(child);
    expect(isAlive(child)).toBe(true);

    await killProcessGroup(agent.pid!, 1000);

    expect(await waitFor(() => !isAlive(child))).toBe(true);
  });

  it('escalates to SIGKILL for a group member that ignores SIGTERM', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imagos-tree-'));
    const pidFile = path.join(tmp, 'child.pid');
    const agent = execa('sh', ['-c', `sh -c 'trap "" TERM; echo $$ > ${pidFile}; while :; do sleep 1; done' & wait`], {
      detached: true,
    });
    agent.catch(() => {});
    const child = await readPid(pidFile);
    spawned.push(child);

    await killProcessGroup(agent.pid!, 300);

    expect(await waitFor(() => !isAlive(child))).toBe(true);
  });

  it('finds and kills orphans that escaped the group but still run inside the worktree', async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'imagos-tree-')));
    const worktree = path.join(tmp, 'issue-1');
    fs.mkdirSync(worktree);
    const pidFile = path.join(tmp, 'orphan.pid');
    // The parent exits immediately, leaving the sleep reparented to init with its cwd in the worktree
    await execa('sh', ['-c', `cd ${worktree} && (sleep 60 >/dev/null 2>&1 & echo $! > ${pidFile})`]);
    const orphan = await readPid(pidFile);
    spawned.push(orphan);

    expect(await findOrphansInDir(tmp)).toContain(orphan);
    expect(await findOrphansInDir(path.join(tmp, 'elsewhere'))).not.toContain(orphan);

    await killOrphansInDir(worktree, 1000);

    expect(await waitFor(() => !isAlive(orphan))).toBe(true);
  });

  it('leaves processes whose parent is still alive alone', async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'imagos-tree-')));
    const owned = execa('sleep', ['60'], { cwd: tmp });
    owned.catch(() => {});
    spawned.push(owned.pid!);

    await reapAgentProcesses(undefined, tmp);

    expect(isAlive(owned.pid!)).toBe(true);
  });
});
