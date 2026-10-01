import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { killOrphansInDir } from '../runners/process_tree.js';

export interface WorktreeInfo {
  path: string;
  branch: string;
  issueNumber?: number;
}

export class WorktreeManager {
  private baseDir: string;
  private worktreesRoot: string;

  constructor(baseDir: string = process.cwd()) {
    this.baseDir = baseDir;
    this.worktreesRoot = path.resolve(baseDir, '.autopilot', 'worktrees');
  }

  public getWorktreesRoot(): string {
    return this.worktreesRoot;
  }

  private sanitizeSlug(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30);
  }

  public getBranchName(issueNumber: number, title: string): string {
    const slug = this.sanitizeSlug(title);
    return `agent/issue-${issueNumber}-${slug}`;
  }

  public getWorktreePathForIssue(issueNumber: number, title?: string): string {
    if (title) {
      const slug = this.sanitizeSlug(title);
      return path.resolve(this.worktreesRoot, `issue-${issueNumber}-${slug}`);
    }

    // Try finding existing worktree matching issueNumber prefix
    if (fs.existsSync(this.worktreesRoot)) {
      const entries = fs.readdirSync(this.worktreesRoot);
      const match = entries.find((e) => e.startsWith(`issue-${issueNumber}`));
      if (match) {
        return path.resolve(this.worktreesRoot, match);
      }
    }

    return path.resolve(this.worktreesRoot, `issue-${issueNumber}`);
  }

  public async worktreeExists(issueNumber: number): Promise<boolean> {
    const worktreePath = this.getWorktreePathForIssue(issueNumber);
    return fs.existsSync(worktreePath);
  }

  public async pruneWorktrees(): Promise<void> {
    try {
      await execa('git', ['worktree', 'prune'], { cwd: this.baseDir });
    } catch {
      // Best effort
    }
  }

  public async branchExists(branchName: string): Promise<boolean> {
    try {
      await execa('git', ['rev-parse', '--verify', branchName], { cwd: this.baseDir });
      return true;
    } catch {
      return false;
    }
  }

  public async createWorktree(
    issueNumber: number,
    title: string,
    baseBranch: string = 'main'
  ): Promise<{ worktreePath: string; branchName: string }> {
    const branchName = this.getBranchName(issueNumber, title);
    const worktreePath = this.getWorktreePathForIssue(issueNumber, title);

    if (fs.existsSync(worktreePath)) {
      return { worktreePath, branchName };
    }

    fs.mkdirSync(this.worktreesRoot, { recursive: true });

    // Prune any stale worktree registrations before adding
    await this.pruneWorktrees();

    // Fetch latest baseBranch from remote
    try {
      await execa('git', ['fetch', 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`], { cwd: this.baseDir });
    } catch {
      try {
        await execa('git', ['fetch', 'origin', baseBranch], { cwd: this.baseDir });
      } catch {
        // Offline or local only branch
      }
    }

    // Determine base ref (origin/baseBranch or local baseBranch)
    let startPoint = `origin/${baseBranch}`;
    try {
      await execa('git', ['rev-parse', '--verify', startPoint], { cwd: this.baseDir });
    } catch {
      try {
        await execa('git', ['rev-parse', '--verify', baseBranch], { cwd: this.baseDir });
        startPoint = baseBranch;
      } catch {
        startPoint = 'HEAD';
      }
    }

    // Check if branch already exists
    const branchExists = await this.branchExists(branchName);

    if (branchExists) {
      try {
        await execa('git', ['worktree', 'add', worktreePath, branchName], { cwd: this.baseDir });
      } catch {
        await this.pruneWorktrees();
        await execa('git', ['worktree', 'add', '-f', worktreePath, branchName], { cwd: this.baseDir });
      }
      try {
        await this.rebaseWorktree(worktreePath, baseBranch);
      } catch {
        await this.abortRebase(worktreePath);
      }
    } else {
      try {
        await execa('git', ['worktree', 'add', '-b', branchName, worktreePath, startPoint], {
          cwd: this.baseDir,
        });
      } catch {
        await this.pruneWorktrees();
        const existsNow = await this.branchExists(branchName);
        if (existsNow) {
          await execa('git', ['worktree', 'add', '-f', worktreePath, branchName], { cwd: this.baseDir });
          try {
            await this.rebaseWorktree(worktreePath, baseBranch);
          } catch {
            await this.abortRebase(worktreePath);
          }
        } else {
          await execa('git', ['worktree', 'add', '-f', '-b', branchName, worktreePath, startPoint], {
            cwd: this.baseDir,
          });
        }
      }
    }

    return { worktreePath, branchName };
  }

  public async rebaseWorktree(
    worktreePath: string,
    baseBranch: string = 'main'
  ): Promise<{ success: boolean; hasConflicts: boolean; output: string }> {
    try {
      await execa('git', ['fetch', 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`], { cwd: worktreePath });
    } catch {
      try {
        await execa('git', ['fetch', 'origin', baseBranch], { cwd: worktreePath });
      } catch {
        // Continue if offline
      }
    }

    let upstream = `origin/${baseBranch}`;
    try {
      await execa('git', ['rev-parse', '--verify', upstream], { cwd: worktreePath });
    } catch {
      upstream = baseBranch;
    }

    try {
      const { stdout, stderr } = await execa('git', ['rebase', upstream], { cwd: worktreePath });
      return { success: true, hasConflicts: false, output: `${stdout}\n${stderr}` };
    } catch (err: any) {
      const output = `${err.stdout || ''}\n${err.stderr || ''}`;
      const hasConflicts = output.includes('CONFLICT') || output.includes('Failed to merge');
      return { success: false, hasConflicts, output };
    }
  }

  public async abortRebase(worktreePath: string): Promise<void> {
    try {
      await execa('git', ['rebase', '--abort'], { cwd: worktreePath });
    } catch {
      // Ignore if not in rebase
    }
  }

  public async commitAll(worktreePath: string, message: string): Promise<boolean> {
    try {
      await execa('git', ['add', '-A'], { cwd: worktreePath });
      const { stdout } = await execa('git', ['status', '--porcelain'], { cwd: worktreePath });
      if (!stdout.trim()) {
        return false; // No changes to commit
      }
      await execa('git', ['commit', '-m', message], { cwd: worktreePath });
      return true;
    } catch {
      return false;
    }
  }

  public async pushBranch(worktreePath: string, branchName: string, force: boolean = false): Promise<void> {
    const args = ['push', '-u', 'origin', branchName];
    if (force) {
      args.push('--force-with-lease');
    }
    await execa('git', args, { cwd: worktreePath });
  }

  public async cleanupWorktree(issueNumber: number, title?: string, deleteBranch: boolean = true): Promise<void> {
    const worktreePath = this.getWorktreePathForIssue(issueNumber, title);
    const branchName = title ? this.getBranchName(issueNumber, title) : undefined;

    if (fs.existsSync(worktreePath)) {
      await killOrphansInDir(worktreePath);
      try {
        await execa('git', ['worktree', 'remove', '--force', worktreePath], { cwd: this.baseDir });
      } catch {
        // Fallback: prune worktrees and delete directory
        try {
          fs.rmSync(worktreePath, { recursive: true, force: true });
          await execa('git', ['worktree', 'prune'], { cwd: this.baseDir });
        } catch {
          // Best effort
        }
      }
    }

    if (deleteBranch) {
      try {
        // Find matching branch name if not provided
        let targetBranch = branchName;
        if (!targetBranch) {
          const { stdout } = await execa('git', ['branch', '--list', `agent/issue-${issueNumber}-*`], {
            cwd: this.baseDir,
          });
          const lines = stdout.split('\n').map((l) => l.replace('*', '').trim()).filter(Boolean);
          if (lines[0]) {
            targetBranch = lines[0];
          }
        }

        if (targetBranch) {
          await execa('git', ['branch', '-D', targetBranch], { cwd: this.baseDir });
        }
      } catch {
        // Branch deletion failure is non-fatal
      }
    }
  }

  // Leftovers from agents of a previous daemon that died without reaping them (crash, kill -9).
  public async killOrphanedProcesses(): Promise<number[]> {
    if (!fs.existsSync(this.worktreesRoot)) return [];
    return killOrphansInDir(this.worktreesRoot);
  }

  public async listActiveWorktrees(): Promise<WorktreeInfo[]> {
    try {
      const { stdout } = await execa('git', ['worktree', 'list', '--porcelain'], { cwd: this.baseDir });
      const items: WorktreeInfo[] = [];
      const blocks = stdout.split('\n\n');

      for (const block of blocks) {
        const lines = block.split('\n');
        let currentPath = '';
        let currentBranch = '';

        for (const line of lines) {
          if (line.startsWith('worktree ')) {
            currentPath = line.substring(9).trim();
          } else if (line.startsWith('branch ')) {
            currentBranch = line.substring(7).replace('refs/heads/', '').trim();
          }
        }

        if (currentPath && currentPath.includes('.autopilot/worktrees/')) {
          const match = path.basename(currentPath).match(/^issue-(\d+)/);
          const issueNumber = match && match[1] ? parseInt(match[1], 10) : undefined;
          items.push({
            path: currentPath,
            branch: currentBranch,
            issueNumber,
          });
        }
      }
      return items;
    } catch {
      return [];
    }
  }
}
