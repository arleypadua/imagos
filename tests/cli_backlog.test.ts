import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { program } from '../src/cli.js';
import { GitHubClient } from '../src/github/client.js';
import type { GitHubIssue } from '../src/types/index.js';

vi.mock('../src/github/client.js');
vi.mock('../src/config/schema.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/schema.js')>();
  return {
    ...actual,
    loadConfig: vi.fn().mockResolvedValue({
      repository: 'test/repo',
      baseBranch: 'main',
      runner: 'claude',
      pollIntervalSeconds: 10,
      maxConcurrency: 2,
      labels: {
        readyForAgent: 'ready-for-agent',
        needsInfo: 'needs-info',
        readyForHuman: 'ready-for-human',
        needsTriage: 'needs-triage',
        wontfix: 'wontfix',
      },
    }),
  };
});

describe('imagos backlog --json', () => {
  let logSpy: any;
  const mockIssues: GitHubIssue[] = [
    {
      number: 1,
      title: 'Ready Task',
      body: 'Do something',
      state: 'OPEN',
      labels: [{ name: 'ready-for-agent' }],
      url: 'https://github.com/test/repo/issues/1',
      createdAt: '2026-08-19T10:00:00Z',
      updatedAt: '2026-08-19T10:00:00Z',
    },
    {
      number: 2,
      title: 'Blocked Task',
      body: '',
      blockedBy: [{ number: 1 }],
      state: 'OPEN',
      labels: [{ name: 'ready-for-agent' }],
      url: 'https://github.com/test/repo/issues/2',
      createdAt: '2026-08-19T10:00:00Z',
      updatedAt: '2026-08-19T10:00:00Z',
    },
    {
      number: 3,
      title: 'Waiting Feedback Task',
      body: 'Need info',
      state: 'OPEN',
      labels: [{ name: 'needs-info' }],
      url: 'https://github.com/test/repo/issues/3',
      createdAt: '2026-08-19T10:00:00Z',
      updatedAt: '2026-08-19T10:00:00Z',
    },
    {
      number: 4,
      title: 'Needs Triage Task',
      body: 'Untriaged issue',
      state: 'OPEN',
      labels: [],
      url: 'https://github.com/test/repo/issues/4',
      createdAt: '2026-08-19T10:00:00Z',
      updatedAt: '2026-08-19T10:00:00Z',
    },
    {
      number: 5,
      title: 'Closed Task',
      body: 'Already done',
      state: 'CLOSED',
      labels: [{ name: 'ready-for-agent' }],
      url: 'https://github.com/test/repo/issues/5',
      createdAt: '2026-08-19T10:00:00Z',
      updatedAt: '2026-08-19T10:00:00Z',
    },
    {
      number: 50,
      title: '[Spec] Feature Spec',
      body: '',
      subIssues: [{ number: 51 }],
      state: 'OPEN',
      labels: [{ name: 'ready-for-agent' }],
      url: 'https://github.com/test/repo/issues/50',
      createdAt: '2026-08-19T10:00:00Z',
      updatedAt: '2026-08-19T10:00:00Z',
    },
    {
      number: 51,
      title: 'Spec Child Task',
      body: '',
      parent: { number: 50 },
      state: 'OPEN',
      labels: [{ name: 'ready-for-agent' }],
      url: 'https://github.com/test/repo/issues/51',
      createdAt: '2026-08-19T10:00:00Z',
      updatedAt: '2026-08-19T10:00:00Z',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(GitHubClient.prototype.fetchIssues).mockResolvedValue(mockIssues);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('should serialize all backlog nodes as a JSON array when --json is specified without filters', async () => {
    await program.parseAsync(['node', 'imagos', 'backlog', '--json']);

    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);

    expect(Array.isArray(parsed)).toBe(true);
    const issueNumbers = parsed.map((n: any) => n.issue.number);
    expect(issueNumbers).toContain(1);
    expect(issueNumbers).toContain(2);
    expect(issueNumbers).toContain(3);
    expect(issueNumbers).toContain(4);
    expect(issueNumbers).toContain(51);
    expect(issueNumbers).not.toContain(5);
  });

  it('should serialize only ready nodes when --json and --ready are specified', async () => {
    await program.parseAsync(['node', 'imagos', 'backlog', '--json', '--ready']);

    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);

    expect(Array.isArray(parsed)).toBe(true);
    const issueNumbers = parsed.map((n: any) => n.issue.number);
    expect(issueNumbers).toContain(1);
    expect(issueNumbers).toContain(51);
    expect(issueNumbers).not.toContain(2);
    expect(issueNumbers).not.toContain(3);
    expect(issueNumbers).not.toContain(4);
  });

  it('should serialize only blocked nodes when --json and --blocked are specified', async () => {
    await program.parseAsync(['node', 'imagos', 'backlog', '--json', '--blocked']);

    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);

    expect(Array.isArray(parsed)).toBe(true);
    const issueNumbers = parsed.map((n: any) => n.issue.number);
    expect(issueNumbers).toEqual([2]);
  });

  it('should serialize only waiting feedback nodes when --json and --pending are specified', async () => {
    await program.parseAsync(['node', 'imagos', 'backlog', '--json', '--pending']);

    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);

    expect(Array.isArray(parsed)).toBe(true);
    const issueNumbers = parsed.map((n: any) => n.issue.number);
    expect(issueNumbers).toEqual([3]);
  });

  it('should serialize only triage nodes when --json and --triage are specified', async () => {
    await program.parseAsync(['node', 'imagos', 'backlog', '--json', '--triage']);

    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);

    expect(Array.isArray(parsed)).toBe(true);
    const issueNumbers = parsed.map((n: any) => n.issue.number);
    expect(issueNumbers).toEqual([4]);
  });

  it('should scope JSON output to specific spec when --spec is passed', async () => {
    await program.parseAsync(['node', 'imagos', 'backlog', '--json', '--spec', '50']);

    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);

    expect(Array.isArray(parsed)).toBe(true);
    const issueNumbers = parsed.map((n: any) => n.issue.number);
    expect(issueNumbers).toEqual([51]);
  });
});
