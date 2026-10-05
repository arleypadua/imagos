import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubClient } from '../src/github/client.js';
import { execa } from 'execa';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

describe('GitHubClient', () => {
  const mockedExeca = vi.mocked(execa);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize repository and cwd from options', () => {
    const client = new GitHubClient({ repository: 'owner/repo', cwd: '/custom/dir' });
    expect(client.getRepository()).toBe('owner/repo');

    client.setRepository('other/repo');
    expect(client.getRepository()).toBe('other/repo');
  });

  describe('checkAuth', () => {
    it('should return true when gh auth status succeeds', async () => {
      mockedExeca.mockResolvedValueOnce({ stdout: 'Logged in' } as any);
      const client = new GitHubClient();
      const authed = await client.checkAuth();
      expect(authed).toBe(true);
      expect(mockedExeca).toHaveBeenCalledWith('gh', ['auth', 'status'], { cwd: expect.any(String) });
    });

    it('should return false when gh auth status throws', async () => {
      mockedExeca.mockRejectedValueOnce(new Error('Not logged in'));
      const client = new GitHubClient();
      const authed = await client.checkAuth();
      expect(authed).toBe(false);
    });
  });

  describe('fetchIssues', () => {
    it('should fetch and parse issues with native relationships via GraphQL', async () => {
      const mockGraphQLResponse = {
        data: {
          repository: {
            issues: {
              nodes: [
                {
                  number: 187,
                  title: 'Spec: Vite/React SSR',
                  body: 'Spec body',
                  state: 'OPEN',
                  url: 'https://github.com/owner/repo/issues/187',
                  createdAt: '2026-08-18T08:30:51Z',
                  updatedAt: '2026-08-18T14:02:22Z',
                  labels: {
                    nodes: [{ name: 'ready-for-agent', color: '0E8A16', description: 'Ready' }],
                  },
                  parent: null,
                  blockedBy: {
                    nodes: [{ number: 186, title: 'Hostname routing', state: 'OPEN' }],
                  },
                  blocking: { nodes: [] },
                  subIssues: {
                    nodes: [{ number: 195, title: 'Upload static assets', state: 'OPEN' }],
                  },
                },
              ],
            },
          },
        },
      };

      mockedExeca.mockResolvedValueOnce({ stdout: JSON.stringify(mockGraphQLResponse) } as any);

      const client = new GitHubClient({ repository: 'owner/repo' });
      const issues = await client.fetchIssues();

      expect(issues).toHaveLength(1);
      expect(issues[0].number).toBe(187);
      expect(issues[0].blockedBy).toEqual([{ number: 186, title: 'Hostname routing', state: 'OPEN' }]);
      expect(issues[0].subIssues).toEqual([{ number: 195, title: 'Upload static assets', state: 'OPEN' }]);
      expect(issues[0].labels).toEqual([{ name: 'ready-for-agent', color: '0E8A16', description: 'Ready' }]);
      expect(mockedExeca).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['api', 'graphql']),
        expect.any(Object)
      );
    });

    it('should keep the repository of each blocker so cross-repo blockers are not mistaken for local issues', async () => {
      const response = {
        data: {
          repository: {
            issues: {
              nodes: [
                {
                  number: 68,
                  title: 'Emulator ticket',
                  body: '',
                  state: 'OPEN',
                  url: 'https://github.com/owner/pkh-emu/issues/68',
                  createdAt: '2026-08-18T08:30:51Z',
                  updatedAt: '2026-08-18T14:02:22Z',
                  repository: { nameWithOwner: 'owner/pkh-emu' },
                  labels: { nodes: [] },
                  parent: null,
                  blockedBy: {
                    nodes: [
                      { number: 213, title: 'SDK release', state: 'CLOSED', repository: { nameWithOwner: 'owner/issue-tracker' } },
                    ],
                  },
                  blocking: { nodes: [] },
                  subIssues: { nodes: [] },
                },
              ],
            },
          },
        },
      };

      mockedExeca.mockResolvedValueOnce({ stdout: JSON.stringify(response) } as any);

      const client = new GitHubClient({ repository: 'owner/pkh-emu' });
      const issues = await client.fetchIssues();

      expect(issues[0].repository).toBe('owner/pkh-emu');
      expect(issues[0].blockedBy).toEqual([
        { number: 213, title: 'SDK release', state: 'CLOSED', repository: 'owner/issue-tracker' },
      ]);
      const query = (mockedExeca.mock.calls[0][1] as string[]).find((a) => a.startsWith('query='))!;
      expect(query).toMatch(/blockedBy\(first: 50\) \{\s*nodes \{[^}]*repository \{\s*nameWithOwner/);
    });

    it('should page through every issue instead of stopping at the first page', async () => {
      const pageOf = (numbers: number[], hasNextPage: boolean, endCursor: string | null) => ({
        data: {
          repository: {
            issues: {
              pageInfo: { hasNextPage, endCursor },
              nodes: numbers.map((number) => ({
                number,
                title: `Issue ${number}`,
                body: '',
                state: 'OPEN',
                url: `https://github.com/owner/repo/issues/${number}`,
                createdAt: '2026-08-01T00:00:00Z',
                updatedAt: '2026-08-01T00:00:00Z',
                labels: { nodes: [] },
                parent: null,
                blockedBy: { nodes: [] },
                blocking: { nodes: [] },
                subIssues: { nodes: [] },
                comments: { nodes: [] },
              })),
            },
          },
        },
      });

      mockedExeca.mockResolvedValueOnce({ stdout: JSON.stringify(pageOf([303, 302], true, 'CURSOR_1')) } as any);
      mockedExeca.mockResolvedValueOnce({ stdout: JSON.stringify(pageOf([47, 35], false, null)) } as any);

      const client = new GitHubClient({ repository: 'owner/repo' });
      const issues = await client.fetchIssues();

      expect(issues.map((i) => i.number)).toEqual([303, 302, 47, 35]);
      expect(mockedExeca).toHaveBeenCalledTimes(2);
      expect(mockedExeca.mock.calls[0][1]).not.toContain('after=CURSOR_1');
      expect(mockedExeca.mock.calls[1][1]).toContain('after=CURSOR_1');
    });

    it('should stop after a single page when the response carries no pageInfo', async () => {
      const mockGraphQLResponse = {
        data: { repository: { issues: { nodes: [] } } },
      };
      mockedExeca.mockResolvedValueOnce({ stdout: JSON.stringify(mockGraphQLResponse) } as any);

      const client = new GitHubClient({ repository: 'owner/repo' });
      await client.fetchIssues();

      expect(mockedExeca).toHaveBeenCalledTimes(1);
    });

    it('should fallback to gh issue list when GraphQL fails', async () => {
      const mockCliIssues = [
        { number: 1, title: 'Issue 1', body: 'Body 1', state: 'OPEN', labels: [], url: 'https://...', createdAt: '', updatedAt: '' },
      ];

      // First call (GraphQL) fails
      mockedExeca.mockRejectedValueOnce(new Error('GraphQL error'));
      // Second call (CLI list) succeeds
      mockedExeca.mockResolvedValueOnce({ stdout: JSON.stringify(mockCliIssues) } as any);

      const client = new GitHubClient({ repository: 'owner/repo' });
      const issues = await client.fetchIssues();

      expect(issues).toEqual(mockCliIssues);
      expect(mockedExeca).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['issue', 'list', '--repo', 'owner/repo']),
        expect.any(Object)
      );
    });

    describe('incremental sync', () => {
      const node = (number: number, title = `Issue ${number}`) => ({
        number,
        title,
        body: '',
        state: 'OPEN',
        url: `https://github.com/owner/repo/issues/${number}`,
        createdAt: '2026-08-01T00:00:00Z',
        updatedAt: '2026-08-01T00:00:00Z',
        labels: { nodes: [] },
        parent: null,
        blockedBy: { nodes: [] },
        blocking: { nodes: [] },
        subIssues: { nodes: [] },
        comments: { nodes: [] },
      });
      const page = (nodes: any[]) => ({
        stdout: JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } }),
      });

      it('should only ask for issues updated since the last sync and merge them into the cache', async () => {
        mockedExeca.mockResolvedValueOnce(page([node(2), node(1)]) as any);
        mockedExeca.mockResolvedValueOnce(page([node(1, 'Renamed')]) as any);

        const client = new GitHubClient({ repository: 'owner/repo' });
        await client.fetchIssues();
        const issues = await client.fetchIssues();

        expect(mockedExeca.mock.calls[0][1]).not.toContainEqual(expect.stringMatching(/^since=/));
        expect(mockedExeca.mock.calls[1][1]).toContainEqual(expect.stringMatching(/^since=/));
        expect(issues.map((i) => [i.number, i.title])).toEqual([
          [2, 'Issue 2'],
          [1, 'Renamed'],
        ]);
      });

      it('should re-read every issue once the full sync interval has passed', async () => {
        mockedExeca.mockResolvedValueOnce(page([node(2), node(1)]) as any);
        mockedExeca.mockResolvedValueOnce(page([node(2)]) as any);

        const client = new GitHubClient({ repository: 'owner/repo', fullSyncIntervalMs: 0 });
        await client.fetchIssues();
        const issues = await client.fetchIssues();

        expect(mockedExeca.mock.calls[1][1]).not.toContainEqual(expect.stringMatching(/^since=/));
        expect(issues.map((i) => i.number)).toEqual([2]);
      });

      it('should serve cached issues without calling GitHub while rate limited', async () => {
        mockedExeca.mockResolvedValueOnce(page([node(1)]) as any);
        mockedExeca.mockRejectedValueOnce(new Error('GraphQL: API rate limit already exceeded for user ID 1.'));
        mockedExeca.mockResolvedValueOnce({ stdout: JSON.stringify({ remaining: 0, reset: Date.now() / 1000 + 600 }) } as any);

        const client = new GitHubClient({ repository: 'owner/repo' });
        await client.fetchIssues();
        const limited = await client.fetchIssues();
        const stillLimited = await client.fetchIssues();

        expect(limited.map((i) => i.number)).toEqual([1]);
        expect(stillLimited.map((i) => i.number)).toEqual([1]);
        expect(mockedExeca).toHaveBeenCalledTimes(3);
        expect(mockedExeca).not.toHaveBeenCalledWith('gh', expect.arrayContaining(['issue', 'list']), expect.any(Object));
      });

      it('should throw instead of falling back to gh issue list when rate limited with an empty cache', async () => {
        mockedExeca.mockRejectedValueOnce(new Error('GraphQL: API rate limit already exceeded for user ID 1.'));
        mockedExeca.mockRejectedValueOnce(new Error('network down'));

        const client = new GitHubClient({ repository: 'owner/repo' });
        await expect(client.fetchIssues()).rejects.toThrow('rate limit');
        expect(mockedExeca).not.toHaveBeenCalledWith('gh', expect.arrayContaining(['issue', 'list']), expect.any(Object));
      });
    });

    it('should fetch via CLI directly with fetchIssuesViaCli', async () => {
      const mockIssues = [
        { number: 1, title: 'Issue 1', body: 'Body 1', state: 'OPEN', labels: [], url: 'https://...', createdAt: '', updatedAt: '' },
      ];
      mockedExeca.mockResolvedValueOnce({ stdout: JSON.stringify(mockIssues) } as any);

      const client = new GitHubClient({ repository: 'owner/repo' });
      const issues = await client.fetchIssuesViaCli();

      expect(issues).toEqual(mockIssues);
    });

    it('should return empty array if output is blank in fetchIssuesViaCli', async () => {
      mockedExeca.mockResolvedValueOnce({ stdout: '   ' } as any);

      const client = new GitHubClient();
      const issues = await client.fetchIssuesViaCli();
      expect(issues).toEqual([]);
    });

    it('should throw error on invalid JSON output in fetchIssuesViaCli', async () => {
      mockedExeca.mockResolvedValueOnce({ stdout: 'invalid json' } as any);

      const client = new GitHubClient();
      await expect(client.fetchIssuesViaCli()).rejects.toThrow('Failed to parse gh issue list output');
    });
  });

  describe('viewIssue and fetchIssue', () => {
    it('should fetch single issue by number', async () => {
      const mockIssue = { number: 42, title: 'Issue 42', body: 'Body', state: 'OPEN', labels: [], url: 'https://...', createdAt: '', updatedAt: '' };
      mockedExeca.mockResolvedValueOnce({ stdout: JSON.stringify(mockIssue) } as any);

      const client = new GitHubClient({ repository: 'owner/repo' });
      const issue = await client.viewIssue(42);

      expect(issue).toEqual(mockIssue);
      expect(mockedExeca).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['issue', 'view', '42', '--repo', 'owner/repo']),
        expect.any(Object)
      );
    });

    it('fetchIssue alias should delegate to viewIssue', async () => {
      const mockIssue = { number: 7, title: 'Issue 7', body: '', state: 'OPEN', labels: [], url: '', createdAt: '', updatedAt: '' };
      mockedExeca.mockResolvedValueOnce({ stdout: JSON.stringify(mockIssue) } as any);

      const client = new GitHubClient();
      const issue = await client.fetchIssue(7);

      expect(issue).toEqual(mockIssue);
      expect(mockedExeca).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['issue', 'view', '7']),
        expect.any(Object)
      );
    });
  });

  describe('ensureLabelExists and ensureLabelsExist', () => {
    it('should create label with default color and description if known', async () => {
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as any);

      const client = new GitHubClient({ repository: 'owner/repo' });
      await client.ensureLabelExists('ready-for-agent');

      expect(mockedExeca).toHaveBeenCalledWith(
        'gh',
        [
          'label',
          'create',
          'ready-for-agent',
          '--repo',
          'owner/repo',
          '--color',
          '0E8A16',
          '--force',
          '--description',
          'Queued for autonomous agent execution',
        ],
        expect.any(Object)
      );
    });

    it('should ensure multiple labels exist from record or array', async () => {
      mockedExeca.mockResolvedValue({ stdout: '' } as any);

      const client = new GitHubClient({ repository: 'owner/repo' });
      await client.ensureLabelsExist({
        readyForAgent: 'ready-for-agent',
        needsInfo: 'needs-info',
      });

      expect(mockedExeca).toHaveBeenCalledTimes(2);
      expect(mockedExeca).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['label', 'create', 'ready-for-agent']),
        expect.any(Object)
      );
      expect(mockedExeca).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['label', 'create', 'needs-info']),
        expect.any(Object)
      );
    });
  });

  describe('editIssueLabels', () => {
    it('should edit labels with add and remove options', async () => {
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as any);

      const client = new GitHubClient({ repository: 'owner/repo' });
      await client.editIssueLabels(10, { add: ['ready-for-agent'], remove: ['needs-info'] });

      expect(mockedExeca).toHaveBeenCalledWith(
        'gh',
        ['issue', 'edit', '10', '--repo', 'owner/repo', '--add-label', 'ready-for-agent', '--remove-label', 'needs-info'],
        expect.any(Object)
      );
    });

    it('should attempt label creation for both added and removed labels and retry if initial edit fails', async () => {
      mockedExeca
        .mockRejectedValueOnce(new Error("'needs-info' not found"))
        .mockResolvedValueOnce({ stdout: '' } as any) // label create ready-for-agent
        .mockResolvedValueOnce({ stdout: '' } as any) // label create needs-info
        .mockResolvedValueOnce({ stdout: '' } as any); // retry edit

      const client = new GitHubClient({ repository: 'owner/repo' });
      await client.editIssueLabels(202, {
        add: ['ready-for-agent'],
        remove: ['needs-info'],
      });

      expect(mockedExeca).toHaveBeenCalledTimes(4);
    });

    it('should fallback to applying add-only labels if remove still fails on retry', async () => {
      mockedExeca
        .mockRejectedValueOnce(new Error("'needs-info' not found")) // first edit attempt fails
        .mockResolvedValueOnce({ stdout: '' } as any) // ensure ready-for-agent
        .mockResolvedValueOnce({ stdout: '' } as any) // ensure needs-info
        .mockRejectedValueOnce(new Error("'needs-info' not found")) // retry with remove fails
        .mockResolvedValueOnce({ stdout: '' } as any); // add-only fallback succeeds

      const client = new GitHubClient({ repository: 'owner/repo' });
      await client.editIssueLabels(202, {
        add: ['ready-for-agent'],
        remove: ['needs-info'],
      });

      expect(mockedExeca).toHaveBeenCalledTimes(5);
      expect(mockedExeca).toHaveBeenLastCalledWith(
        'gh',
        ['issue', 'edit', '202', '--repo', 'owner/repo', '--add-label', 'ready-for-agent'],
        expect.any(Object)
      );
    });
  });

  describe('addComment and closeIssue', () => {
    it('should add comment to issue', async () => {
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as any);

      const client = new GitHubClient({ repository: 'owner/repo' });
      await client.addComment(5, 'Test comment');

      expect(mockedExeca).toHaveBeenCalledWith(
        'gh',
        ['issue', 'comment', '5', '--repo', 'owner/repo', '--body', 'Test comment'],
        expect.any(Object)
      );
    });

    it('should close issue with optional comment', async () => {
      mockedExeca.mockResolvedValue({ stdout: '' } as any);

      const client = new GitHubClient({ repository: 'owner/repo' });
      await client.closeIssue(5, 'Closing now');

      expect(mockedExeca).toHaveBeenCalledWith(
        'gh',
        ['issue', 'comment', '5', '--repo', 'owner/repo', '--body', 'Closing now'],
        expect.any(Object)
      );
      expect(mockedExeca).toHaveBeenCalledWith(
        'gh',
        ['issue', 'close', '5', '--repo', 'owner/repo'],
        expect.any(Object)
      );
    });
  });

  describe('createPR and createPullRequest', () => {
    it('should create PR and return url and parsed number', async () => {
      mockedExeca.mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo/pull/123\n' } as any);

      const client = new GitHubClient({ repository: 'owner/repo' });
      const result = await client.createPR({
        title: 'Feature: Docs',
        body: 'Closes #7',
        head: 'agent/branch',
        base: 'main',
        draft: true,
      });

      expect(result).toEqual({ url: 'https://github.com/owner/repo/pull/123', number: 123 });
      expect(mockedExeca).toHaveBeenCalledWith(
        'gh',
        ['pr', 'create', '--repo', 'owner/repo', '--title', 'Feature: Docs', '--body', 'Closes #7', '--head', 'agent/branch', '--base', 'main', '--draft'],
        expect.any(Object)
      );
    });

    it('createPullRequest alias should delegate to createPR', async () => {
      mockedExeca.mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo/pull/99\n' } as any);

      const client = new GitHubClient();
      const result = await client.createPullRequest({
        title: 'PR Title',
        body: 'PR Body',
        head: 'branch',
        base: 'main',
      });

      expect(result.number).toBe(99);
    });
  });

  describe('mergePR and mergePullRequest', () => {
    it('should merge PR with auto-merge and delete-branch', async () => {
      mockedExeca.mockResolvedValueOnce({ stdout: '' } as any);

      const client = new GitHubClient({ repository: 'owner/repo' });
      await client.mergePR(123, 'squash', true);

      expect(mockedExeca).toHaveBeenCalledWith(
        'gh',
        ['pr', 'merge', '123', '--repo', 'owner/repo', '--squash', '--auto', '--delete-branch'],
        expect.any(Object)
      );
    });

    it('should fallback to direct merge when auto-merge fails', async () => {
      mockedExeca
        .mockRejectedValueOnce(new Error('auto merge failed'))
        .mockResolvedValueOnce({ stdout: '' } as any);

      const client = new GitHubClient();
      await client.mergePR(123, 'rebase', false);

      expect(mockedExeca).toHaveBeenCalledTimes(2);
      expect(mockedExeca).toHaveBeenLastCalledWith(
        'gh',
        ['pr', 'merge', '123', '--rebase'],
        expect.any(Object)
      );
    });

    it('mergePullRequest supports options object or string', async () => {
      mockedExeca.mockResolvedValue({ stdout: '' } as any);

      const client = new GitHubClient();
      await client.mergePullRequest(123, { method: 'merge', deleteBranch: false });

      expect(mockedExeca).toHaveBeenCalledWith(
        'gh',
        ['pr', 'merge', '123', '--merge', '--auto'],
        expect.any(Object)
      );
    });
  });

  describe('findPRForBranch', () => {
    it('should return found PR details', async () => {
      const mockPRs = [{ number: 50, url: 'https://github.com/owner/repo/pull/50', state: 'OPEN' }];
      mockedExeca.mockResolvedValueOnce({ stdout: JSON.stringify(mockPRs) } as any);

      const client = new GitHubClient({ repository: 'owner/repo' });
      const pr = await client.findPRForBranch('feat/test');

      expect(pr).toEqual(mockPRs[0]);
    });

    it('should return undefined if no PR found', async () => {
      mockedExeca.mockResolvedValueOnce({ stdout: '[]' } as any);

      const client = new GitHubClient();
      const pr = await client.findPRForBranch('feat/none');

      expect(pr).toBeUndefined();
    });
  });
});
