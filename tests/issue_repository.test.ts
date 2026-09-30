import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Orchestrator } from '../src/pipeline/orchestrator.js';
import type { AutoPilotConfig, DAGNode, GitHubIssue, TaskContext } from '../src/types/index.js';
import { GitHubClient } from '../src/github/client.js';
import {
  AutoPilotConfigSchema,
  formatRepoLabel,
  getExternalIssueRepository,
  getIssueRepository,
} from '../src/config/schema.js';
import { buildRunnerPrompt } from '../src/runners/prompt.js';

vi.mock('../src/github/client.js');
vi.mock('../src/worktree/manager.js');
vi.mock('../src/runners/facade.js');
vi.mock('../src/notifications/notifier.js');

describe('issue repository config helpers', () => {
  it('defaults the issue repository to the code repository', () => {
    const config = { repository: 'owner/code' };
    expect(getIssueRepository(config)).toBe('owner/code');
    expect(getExternalIssueRepository(config)).toBeUndefined();
    expect(formatRepoLabel(config)).toBe('owner/code');
  });

  it('treats an issue repository equal to the code repository as not external', () => {
    const config = { repository: 'Owner/Code', issueRepository: 'owner/code' };
    expect(getExternalIssueRepository(config)).toBeUndefined();
  });

  it('resolves a separate issue repository', () => {
    const config = { repository: 'owner/code', issueRepository: 'org/issue-tracker' };
    expect(getIssueRepository(config)).toBe('org/issue-tracker');
    expect(getExternalIssueRepository(config)).toBe('org/issue-tracker');
    expect(formatRepoLabel(config)).toBe('owner/code ← org/issue-tracker');
  });

  it('validates the issue repository format', () => {
    expect(() => AutoPilotConfigSchema.parse({ issueRepository: 'not-a-repo' })).toThrow();
    expect(AutoPilotConfigSchema.parse({ issueRepository: 'org/issue-tracker' }).issueRepository).toBe(
      'org/issue-tracker'
    );
  });
});

describe('runner prompt with a separate issue repository', () => {
  const context: TaskContext = {
    issue: {
      number: 12,
      title: 'Add export',
      body: 'Export things.',
      state: 'OPEN',
      labels: [{ name: 'ready-for-agent' }],
      url: 'https://github.com/org/issue-tracker/issues/12',
    },
    kind: 'ticket',
    worktreePath: '/tmp/worktree-12',
    branchName: 'agent/issue-12',
    baseBranch: 'main',
  };

  it('keeps short references and bare gh issue commands when issues live with the code', () => {
    const prompt = buildRunnerPrompt(context);
    expect(prompt).toContain('--body "Closes #12');
    expect(prompt).toContain('gh issue comment 12 --body');
    expect(prompt).not.toContain('-R ');
    expect(prompt).not.toContain('**Issue tracker**');
  });

  it('qualifies the Closes reference and targets gh issue commands at the issue repository', () => {
    const prompt = buildRunnerPrompt({ ...context, issueRepository: 'org/issue-tracker' });
    expect(prompt).toContain('**Issue tracker**');
    expect(prompt).toContain('--body "Closes org/issue-tracker#12');
    expect(prompt).toContain('gh issue comment 12 -R org/issue-tracker --body');
    expect(prompt).toContain('gh issue edit 12 -R org/issue-tracker --add-label');
    expect(prompt).toContain('gh issue create -R org/issue-tracker --title');
  });
});

describe('Orchestrator with a separate issue repository', () => {
  let config: AutoPilotConfig;
  let orchestrator: Orchestrator;
  let issuesGh: any;
  let codeGh: any;
  let mockWorktreeMgr: any;
  let mockRunnerFacade: any;

  const issue: GitHubIssue = {
    number: 12,
    title: 'Add export',
    body: 'Export things.',
    state: 'OPEN',
    labels: [{ name: 'ready-for-agent' }],
    url: 'https://github.com/org/issue-tracker/issues/12',
  };

  const makeNode = (): DAGNode => ({
    issue: { ...issue },
    kind: 'ticket',
    blockers: [],
    dependents: [],
    children: [],
    status: 'ready',
    runnerName: 'claude',
  });

  beforeEach(() => {
    vi.clearAllMocks();

    config = {
      repository: 'owner/code',
      issueRepository: 'org/issue-tracker',
      baseBranch: 'main',
      maxConcurrency: 1,
      maxAutoNudges: 1,
      maxRetriesOnFailure: 0,
      pollIntervalSeconds: 10,
      runner: 'claude',
      autoMerge: true,
      mergeMethod: 'squash',
      cleanupWorktreeOnClose: false,
      remote: { enabled: false, provider: 'telegram', telegram: { botTokenEnv: 'TOKEN', notifications: { needsInfo: true, quotaPaused: true, taskCompleted: true, specCompleted: true } } },
      quota: { pauseOnLimit: true, utilizationThreshold: 0.85, proxyPort: 9876 },
      labels: {
        readyForAgent: 'ready-for-agent',
        needsInfo: 'needs-info',
        readyForHuman: 'ready-for-human',
        needsTriage: 'needs-triage',
        wontfix: 'wontfix',
      },
    };

    orchestrator = new Orchestrator(config);
    issuesGh = (orchestrator as any).gh;
    codeGh = (orchestrator as any).codeGh;
    mockWorktreeMgr = (orchestrator as any).worktreeMgr;
    mockRunnerFacade = (orchestrator as any).runnerFacade;

    mockWorktreeMgr.worktreeExists.mockResolvedValue(false);
    mockWorktreeMgr.createWorktree.mockResolvedValue({
      worktreePath: '/tmp/worktree-12',
      branchName: 'agent/issue-12',
    });
    issuesGh.addComment.mockResolvedValue({});
    issuesGh.editIssueLabels.mockResolvedValue({});
    issuesGh.closeIssue.mockResolvedValue({});
    issuesGh.viewIssue.mockResolvedValue({ ...issue });
    mockRunnerFacade.run.mockResolvedValue({ success: true, status: 'COMPLETED' });
  });

  it('builds separate clients for the issue and code repositories', () => {
    const constructed = vi.mocked(GitHubClient).mock.calls.map((call) => call[0]?.repository);
    expect(constructed).toEqual(['org/issue-tracker', 'owner/code']);
    expect(codeGh).not.toBe(issuesGh);
  });

  it('shares one client when issues live with the code', () => {
    const sameRepo = new Orchestrator({ ...config, issueRepository: undefined });
    expect((sameRepo as any).codeGh).toBe((sameRepo as any).gh);
  });

  it('passes the issue repository to the runner', async () => {
    codeGh.findPRForBranch.mockResolvedValue({ number: 5, url: 'https://github.com/owner/code/pull/5', state: 'OPEN' });
    codeGh.mergePR.mockResolvedValue({});

    await (orchestrator as any).executeTask(makeNode(), undefined, 0, 0);

    expect(mockRunnerFacade.run.mock.calls[0][0].issueRepository).toBe('org/issue-tracker');
  });

  it('finds and merges the PR in the code repository, then closes the issue in the tracker', async () => {
    codeGh.findPRForBranch.mockResolvedValue({ number: 5, url: 'https://github.com/owner/code/pull/5', state: 'OPEN' });
    codeGh.mergePR.mockResolvedValue({});

    await (orchestrator as any).executeTask(makeNode(), undefined, 0, 0);

    expect(codeGh.findPRForBranch).toHaveBeenCalledWith('agent/issue-12');
    expect(codeGh.mergePR).toHaveBeenCalledWith(5, 'squash', true);
    expect(issuesGh.findPRForBranch).not.toHaveBeenCalled();
    expect(issuesGh.closeIssue).toHaveBeenCalledWith(12, expect.stringContaining('https://github.com/owner/code/pull/5'));
  });

  it('closes the issue when the agent already merged the PR but the issue stayed open', async () => {
    codeGh.findPRForBranch.mockResolvedValue({ number: 5, url: 'https://github.com/owner/code/pull/5', state: 'MERGED' });

    await (orchestrator as any).executeTask(makeNode(), undefined, 0, 0);

    expect(codeGh.mergePR).not.toHaveBeenCalled();
    expect(issuesGh.closeIssue).toHaveBeenCalledWith(12, expect.stringContaining('Closed after merge'));
    expect(issuesGh.editIssueLabels).not.toHaveBeenCalledWith(
      12,
      expect.objectContaining({ add: ['ready-for-human'] })
    );
  });

  it('nudges with a qualified Closes reference when no PR was opened', async () => {
    codeGh.findPRForBranch.mockResolvedValue(null);

    await (orchestrator as any).executeTask(makeNode(), undefined, 0, 0);

    const nudge = mockRunnerFacade.run.mock.calls[1][0].userFeedback;
    expect(nudge).toContain('Closes org/issue-tracker#12');
    expect(nudge).toContain('gh issue comment 12 -R org/issue-tracker');
  });
});
