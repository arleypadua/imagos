import { describe, it, expect } from 'vitest';
import { parseIssueDependencies } from '../src/github/parser.js';
import type { GitHubIssue } from '../src/types/index.js';

describe('parseIssueDependencies', () => {
  it('should parse native GitHub blockedBy, parent, and subIssues', () => {
    const issue: GitHubIssue = {
      number: 187,
      title: 'Spec: Vite/React SSR',
      body: 'No blockers in text',
      state: 'OPEN',
      labels: [{ name: 'ready-for-agent' }],
      url: 'https://github.com/owner/repo/issues/187',
      createdAt: '2026-08-19T10:00:00Z',
      updatedAt: '2026-08-19T10:00:00Z',
      blockedBy: [
        { number: 186, title: 'Hostname routing', state: 'OPEN' },
        { number: 185, title: 'Feasibility spike', state: 'CLOSED' },
      ],
      subIssues: [
        { number: 195, title: 'Upload static assets', state: 'OPEN' },
        { number: 197, title: 'Storage allowance', state: 'OPEN' },
      ],
    };

    const deps = parseIssueDependencies(issue);
    expect(deps.blockers.sort()).toEqual([185, 186]);
    expect(deps.subTaskNumbers.sort()).toEqual([195, 197]);
    expect(deps.kind).toBe('spec');
  });

  it('should parse native parent relationship and mark as ticket', () => {
    const issue: GitHubIssue = {
      number: 195,
      title: 'Upload static assets',
      body: 'Task body without markdown parent',
      state: 'OPEN',
      labels: [{ name: 'ready-for-agent' }],
      url: 'https://github.com/owner/repo/issues/195',
      createdAt: '2026-08-19T10:00:00Z',
      updatedAt: '2026-08-19T10:00:00Z',
      parent: { number: 187, title: 'Spec: Vite/React SSR' },
    };

    const deps = parseIssueDependencies(issue);
    expect(deps.parentNumber).toBe(187);
    expect(deps.kind).toBe('ticket');
  });

  it('should ignore relationships written in the body', () => {
    const issue: GitHubIssue = {
      number: 50,
      title: 'Task with body-only deps',
      body: '## Blocked by\n\n[#10](https://github.com/owner/repo/issues/10)\n\nParent: #100\n\nSubtasks:\n- [ ] #51',
      state: 'OPEN',
      labels: [{ name: 'ready-for-agent' }],
      url: 'https://github.com/owner/repo/issues/50',
      createdAt: '2026-08-19T10:00:00Z',
      updatedAt: '2026-08-19T10:00:00Z',
      blockedBy: [{ number: 20, title: 'Native blocker', state: 'OPEN' }],
      subIssues: [{ number: 52, title: 'Native subtask', state: 'OPEN' }],
      parent: { number: 101, title: 'Native parent' },
    };

    const deps = parseIssueDependencies(issue);
    expect(deps.blockers).toEqual([20]);
    expect(deps.parentNumber).toBe(101);
    expect(deps.subTaskNumbers).toEqual([52]);
  });

  it('should not read a blocker out of prose that names another issue', () => {
    const issue: GitHubIssue = {
      number: 549,
      title: 'Spec: Custom domains for an App',
      body: '## Acceptance criteria\n\n- [ ] A domain serves\n\n**Why this ordering.** [#536](https://github.com/owner/repo/issues/536) depends on it: an App cannot change owner.',
      state: 'OPEN',
      labels: [{ name: 'ready-for-agent' }],
      url: 'https://github.com/owner/repo/issues/549',
      createdAt: '2026-08-31T10:00:00Z',
      updatedAt: '2026-08-31T10:00:00Z',
      subIssues: [{ number: 550, title: 'Spike', state: 'OPEN' }],
    };

    const deps = parseIssueDependencies(issue);
    expect(deps.blockers).toEqual([]);
    expect(deps.kind).toBe('spec');
  });

  it('should classify a Spec as kind "spec" even when it has a parent (nested under an epic)', () => {
    const issue: GitHubIssue = {
      number: 380,
      title: 'Spec: operator restriction — make a Function, App or Tenant unreachable, recorded',
      body: 'Spec for #376. Decisions were settled in a grilling session on 2026-08-24.',
      state: 'OPEN',
      labels: [{ name: 'ready-for-agent' }],
      url: 'https://github.com/wawesomeio/wawesome-monorepo/issues/380',
      createdAt: '2026-08-24T12:00:00Z',
      updatedAt: '2026-08-24T12:00:00Z',
      parent: { number: 376, title: 'Epic: Liability shield' },
      subIssues: [{ number: 381, title: 'Restrict and lift an App, recorded', state: 'OPEN' }],
    };

    const deps = parseIssueDependencies(issue);
    expect(deps.parentNumber).toBe(376);
    expect(deps.subTaskNumbers).toEqual([381]);
    expect(deps.kind).toBe('spec');
  });

  it('should classify issues with spec/epic labels as spec kind', () => {
    const issue: GitHubIssue = {
      number: 400,
      title: 'General overhaul',
      body: 'Overview of the overhaul.',
      state: 'OPEN',
      labels: [{ name: 'ready-for-agent' }, { name: 'epic' }],
      url: 'https://github.com/owner/repo/issues/400',
      createdAt: '2026-08-24T12:00:00Z',
      updatedAt: '2026-08-24T12:00:00Z',
    };

    const deps = parseIssueDependencies(issue);
    expect(deps.kind).toBe('spec');
  });
});
