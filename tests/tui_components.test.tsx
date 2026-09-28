import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { MasterDashboard } from '../src/ui/tui/MasterDashboard.js';
import { InspectView } from '../src/ui/tui/InspectView.js';
import { UsageView } from '../src/ui/tui/UsageView.js';
import { SpecPickerView } from '../src/ui/tui/SpecPickerView.js';
import { ActivityLogView } from '../src/ui/tui/ActivityLogView.js';
import { CategoryIssuesView } from '../src/ui/tui/CategoryIssuesView.js';
import { ProvidersPickerView } from '../src/ui/tui/ProvidersPickerView.js';

describe('TUI Components', () => {
  const dummyConfig: any = {
    repository: 'owner/test-repo',
    baseBranch: 'main',
    maxConcurrency: 2,
    pollIntervalSeconds: 30,
    runner: 'claude',
    autoMerge: true,
    mergeMethod: 'squash',
    cleanupWorktreeOnClose: true,
    quota: { pauseOnLimit: true, utilizationThreshold: 0.95 },
    labels: {
      readyForAgent: 'ready-for-agent',
      needsInfo: 'needs-info',
      readyForHuman: 'ready-for-human',
      needsTriage: 'needs-triage',
      wontfix: 'wontfix',
    },
  };

  it('should render MasterDashboard with worker list and quota', () => {
    const { lastFrame } = render(
      <MasterDashboard
        config={dummyConfig}
        dag={null}
        quotaStatus={null}
        workers={[
          {
            issueNumber: 101,
            title: 'Fix authorization token expiry',
            branchName: 'fix/101-auth',
            status: 'running',
            startedAt: new Date(Date.now() - 65000),
          },
        ]}
        selectedIndex={0}
        activityLogs={['[17:00:00] Daemon started']}
      />
    );

    const output = lastFrame();
    expect(output).toContain('AGENT AUTO-PILOT');
    expect(output).toContain('owner/test-repo');
    expect(output).toContain('#101');
    expect(output).toContain('Fix authorization');
    expect(output).toContain('running');
    expect(output).toContain('Navigate');
  });

  it('should render InspectView with activity stream and prompt input bar', () => {
    const { lastFrame } = render(
      <InspectView
        worker={{
          issueNumber: 101,
          title: 'Fix authorization token expiry',
          branchName: 'fix/101-auth',
          status: 'running',
        }}
        events={[
          {
            id: 'evt-1',
            issueNumber: 101,
            type: 'tool_start',
            timestamp: '17:08:12',
            summary: '🔧 EditFile: src/auth/token.ts',
          },
          {
            id: 'evt-2',
            issueNumber: 101,
            type: 'thought',
            timestamp: '17:08:15',
            summary: 'Checking JWT verification logic',
          },
        ]}
        inputText="Make sure to check expired tokens"
        isSubmitting={false}
      />
    );

    const output = lastFrame();
    expect(output).toContain('LIVE TAIL: Issue #101');
    expect(output).toContain('🔧 EditFile: src/auth/token.ts');
    expect(output).toContain('Checking JWT verification logic');
    expect(output).toContain('❯ Inject prompt: Make sure to check expired tokens');
    expect(output).toContain('[Esc] Back to Overview');
  });

  it('should render paused WIP worktrees on disk in MasterDashboard table', () => {
    const { lastFrame } = render(
      <MasterDashboard
        config={dummyConfig}
        dag={null}
        quotaStatus={{
          isPaused: true,
          resetAt: new Date(Date.now() + 1000 * 60 * 256),
          reason: '5-hour limit reached',
        }}
        workers={[
          {
            issueNumber: 221,
            title: "The CLI's App-slot refusal point",
            branchName: 'agent/issue-221-the-cli-s',
            status: 'paused_quota',
            isWip: true,
          },
        ]}
        selectedIndex={0}
        activityLogs={['[17:44:08] 5h Quota limit hit. Suspended workers until 10:00 PM']}
      />
    );

    const output = lastFrame();
    expect(output).toContain('QUOTA LIMIT PAUSED');
    expect(output).toContain('Resumes automatically');
    expect(output).toContain('manual resume');
    expect(output).toContain('#221');
    expect(output).toContain("The CLI's App-slot");
    expect(output).toContain('agent/issue-221');
    expect(output).toContain('paused');
    expect(output).toContain('preserves WIP');
  });

  it('should render THRESHOLD LIMIT PAUSED banner when paused by threshold', () => {
    const { lastFrame } = render(
      <MasterDashboard
        config={dummyConfig}
        dag={null}
        quotaStatus={{
          isPaused: true,
          pausedRunner: 'claude',
          resetAt: new Date(Date.now() + 1000 * 60 * 120),
          reason: 'Claude Live Session Quota: 74% used (threshold: 70%, resets 5pm)',
        }}
        workers={[]}
        selectedIndex={0}
        activityLogs={[]}
      />
    );

    const output = lastFrame();
    expect(output).toContain('CLAUDE THRESHOLD LIMIT PAUSED');
    expect(output).toContain('Resumes automatically');
    expect(output).toContain('manual resume');
  });

  it('should render CommandPalette in command input mode and display suggestions', () => {
    const { lastFrame } = render(
      <MasterDashboard
        config={dummyConfig}
        dag={null}
        quotaStatus={null}
        workers={[]}
        selectedIndex={0}
        activityLogs={[]}
        commandInput="/us"
        isCommandMode={true}
      />
    );

    const output = lastFrame();
    expect(output).toContain('COMMAND PALETTE');
    expect(output).toContain('❯ /usage');
    expect(output).toContain('❯ Command: /us');
    expect(output).toContain('(press [Tab] for /usage)');
  });

  it('should suggest /install-skills in CommandPalette when filtering by /inst', () => {
    const { lastFrame } = render(
      <MasterDashboard
        config={dummyConfig}
        dag={null}
        quotaStatus={null}
        workers={[]}
        selectedIndex={0}
        activityLogs={[]}
        commandInput="/inst"
        isCommandMode={true}
      />
    );

    const output = lastFrame();
    expect(output).toContain('COMMAND PALETTE');
    expect(output).toContain('/install-skills');
    expect(output).toContain('Install Imagos AI skills');
  });

  it('should render command result telemetry box when /usage is executed', () => {
    const { lastFrame } = render(
      <MasterDashboard
        config={dummyConfig}
        dag={null}
        quotaStatus={null}
        workers={[]}
        selectedIndex={0}
        activityLogs={[]}
        commandResult={{
          type: 'usage',
          title: '📊 Quota Usage & Scheduled Wake-Up Telemetry',
          lines: [
            '● 5h Session Quota: [████████████] 100% used · Resets 10:00:00 PM',
            '⏳ Scheduled Wake-Up: 10:00:00 PM (~256 min remaining)',
            'Status: 5-hour quota paused (waiting for wake-up time)',
          ],
        }}
      />
    );

    const output = lastFrame();
    expect(output).toContain('Quota Usage & Scheduled Wake-Up Telemetry');
    expect(output).toContain('5h Session Quota: [████████████] 100% used');
    expect(output).toContain('Scheduled Wake-Up: 10:00:00 PM (~256 min remaining)');
  });

  it('should render dedicated UsageView window with scheduled wake up and quota bars', () => {
    const { lastFrame } = render(
      <UsageView
        quotaStatus={{
          isPaused: true,
          resetAt: new Date(Date.now() + 1000 * 60 * 256),
          reason: '5-hour limit reached',
          activePids: [1234],
          liveUsage: {
            sessionUsedPercentage: 100,
            sessionResetText: 'Aug 19 at 10:00pm',
            weekUsedPercentage: 62,
            weekResetText: 'Aug 24 at 10:59pm',
            lastFetchedAt: new Date(),
          },
        }}
        repository="owner/test-repo"
      />
    );

    const output = lastFrame();
    expect(output).toContain('LLM RUNNER QUOTA & SCHEDULED WAKE-UP TELEMETRY');
    expect(output).toContain('CLAUDE CODE CLI TELEMETRY');
    expect(output).toContain('5-Hour Session Quota');
    expect(output).toContain('100%');
    expect(output).toContain('Aug 19 at 10:00pm');
    expect(output).toContain('Weekly Account Quota');
    expect(output).toContain('QUOTA LIMIT (PAUSED)');
    expect(output).toContain('Resumes automatically at');
    expect(output).toContain('[Esc] Back to Main Dashboard');
  });

  it('should render SpecPickerView window with multi-select checkboxes and any unblocked task', () => {
    const { lastFrame } = render(
      <SpecPickerView
        options={[
          {
            number: 205,
            title: 'Fix authorization token verification',
            childCount: 4,
            completedCount: 1,
          },
          {
            number: 187,
            title: 'Refactor DAG scheduler pipeline',
            childCount: 6,
            completedCount: 0,
          },
          {
            title: 'Any unblocked task (all ready-for-agent issues)',
            isAllTasks: true,
          },
        ]}
        highlightedIndex={0}
        selectedNumbers={new Set([205, 187])}
        isAllTasksSelected={false}
        repository="owner/test-repo"
      />
    );

    const output = lastFrame();
    expect(output).toContain('SPECIFICATIONS & SCOPE SELECTOR');
    expect(output).toContain('[x]');
    expect(output).toContain('#205');
    expect(output).toContain('Fix authorization token ver');
    expect(output).toContain('1/4 completed');
    expect(output).toContain('#187');
    expect(output).toContain('2 specs selected (#205, #187)');
    expect(output).toContain('[Space] Toggle Scope');
    expect(output).toContain('[Enter] Apply Scope');
  });

  it('should render SpecPickerView with active worker, blockers, and details box', () => {
    const { lastFrame } = render(
      <SpecPickerView
        options={[
          {
            number: 186,
            title: 'Spec: Hostname routing and separate domain',
            childCount: 7,
            completedCount: 2,
            worker: {
              issueNumber: 186,
              title: 'Spec: Hostname routing and separate domain',
              branchName: 'agent/issue-186-routing',
              status: 'running',
            },
            blockers: [185],
            labels: ['ready-for-agent'],
            status: 'ready',
          },
        ]}
        highlightedIndex={0}
        selectedNumbers={new Set([186])}
        isAllTasksSelected={false}
        repository="wawesomeio/wawesome-monorepo"
      />
    );

    const output = lastFrame();
    expect(output).toContain('SPECIFICATIONS & SCOPE SELECTOR');
    expect(output).toContain('#186');
    expect(output).toContain('2/7 completed');
    expect(output).toContain('active worker');
    expect(output).toContain('Blockers: #185');
    expect(output).toContain('Active Worktree: agent/issue-186-routing (running)');
    expect(output).toContain('[o] Open Browser');
    expect(output).toContain('[p] Pause/Resume');
    expect(output).toContain('[x/k] Kill & Wipe');
  });

  it('should render ActivityLogView window with full system logs and scroll footer', () => {
    const { lastFrame } = render(
      <ActivityLogView
        logs={[
          '[18:00:00] Agent Auto-Pilot started.',
          '[18:00:02] Fetched 12 issues from GitHub.',
          '[18:00:05] Started session scoped to Spec(s): #205',
          '[18:00:08] Dispatched Issue #206 to worker.',
        ]}
        repository="owner/test-repo"
      />
    );

    const output = lastFrame();
    expect(output).toContain('SYSTEM & DAEMON ACTIVITY LOGS');
    expect(output).toContain('Agent Auto-Pilot started.');
    expect(output).toContain('Started session scoped to Spec(s): #205');
    expect(output).toContain('Dispatched Issue #206 to worker.');
    expect(output).toContain('[Esc] Back to Main Dashboard');
    expect(output).toContain('[c] Clear Logs');
  });

  it('should render CategoryIssuesView window with issues list and actions', () => {
    const { lastFrame } = render(
      <CategoryIssuesView
        categoryTitle="Ready for Agent"
        issues={[
          {
            issue: {
              number: 206,
              title: 'Implement token caching layer',
              state: 'OPEN',
              labels: [{ name: 'ready-for-agent' }],
              created_at: '2026-08-19T10:00:00Z',
              updated_at: '2026-08-19T10:00:00Z',
              comments: 0,
            },
            status: 'ready',
            worker: {
              issueNumber: 206,
              title: 'Implement token caching layer',
              branchName: 'agent/issue-206',
              status: 'running',
              startedAt: new Date(Date.now() - 65000),
            },
          },
          {
            issue: {
              number: 207,
              title: 'Add JWT unit tests',
              state: 'OPEN',
              labels: [{ name: 'ready-for-agent' }],
              created_at: '2026-08-19T10:00:00Z',
              updated_at: '2026-08-19T10:00:00Z',
              comments: 0,
            },
            status: 'ready',
          },
        ]}
        selectedIndex={0}
        repository="owner/test-repo"
      />
    );

    const output = lastFrame();
    expect(output).toContain('ISSUES: READY FOR AGENT');
    expect(output).toContain('#206');
    expect(output).toContain('Implement token caching layer');
    expect(output).toContain('active worker');
    expect(output).toContain('#207');
    expect(output).toContain('[p] Pause/Resume');
    expect(output).toContain('[k] Kill & Wipe');
    expect(output).toContain('[o] Open in Browser');
  });

  it('should render distinct badges for needs-info vs human-task in CategoryIssuesView', () => {
    const { lastFrame } = render(
      <CategoryIssuesView
        categoryTitle="Human Action Required (Tasks & Feedback)"
        issues={[
          {
            issue: {
              number: 188,
              title: 'Provide database connection credentials',
              state: 'OPEN',
              labels: [{ name: 'needs-info' }],
              created_at: '2026-08-19T10:00:00Z',
              updated_at: '2026-08-19T10:00:00Z',
            } as any,
            status: 'waiting_feedback',
          },
          {
            issue: {
              number: 189,
              title: 'Manual DNS and SSL Certificate Setup',
              state: 'OPEN',
              labels: [{ name: 'ready-for-human' }],
              created_at: '2026-08-19T10:00:00Z',
              updated_at: '2026-08-19T10:00:00Z',
            } as any,
            status: 'waiting_feedback',
          },
          {
            issue: {
              number: 190,
              title: 'Deploy to custom bare-metal server',
              state: 'OPEN',
              labels: [{ name: 'human-task' }],
              created_at: '2026-08-19T10:00:00Z',
              updated_at: '2026-08-19T10:00:00Z',
            } as any,
            status: 'waiting_feedback',
          },
        ]}
        selectedIndex={0}
        repository="owner/test-repo"
      />
    );

    const output = lastFrame();
    expect(output).toContain('ISSUES: HUMAN ACTION REQUIRED (TASKS & FEEDBACK)');
    expect(output).toContain('#188');
    expect(output).toContain('needs info');
    expect(output).toContain('#189');
    expect(output).toContain('human task');
    expect(output).toContain('#190');
  });

  it('should render CategoryIssuesView with kill confirmation modal when requested', () => {
    const { lastFrame } = render(
      <CategoryIssuesView
        categoryTitle="Ready for Agent"
        issues={[
          {
            issue: {
              number: 206,
              title: 'Implement token caching layer',
              state: 'OPEN',
              labels: [{ name: 'ready-for-agent' }],
              created_at: '2026-08-19T10:00:00Z',
              updated_at: '2026-08-19T10:00:00Z',
              comments: 0,
            },
            status: 'ready',
          },
        ]}
        selectedIndex={0}
        confirmAction={{ type: 'kill', issueNumber: 206 }}
        repository="owner/test-repo"
      />
    );

    const output = lastFrame();
    expect(output).toContain('CONFIRM KILL & WIPE WORKTREE: Issue #206');
    expect(output).toContain('Press [y] to confirm and wipe, or [n] / [Esc] to cancel');
  });

  it('should scroll and window CategoryIssuesView when list is large and selectedIndex moves down', () => {
    const issuesList = Array.from({ length: 25 }, (_, i) => ({
      issue: {
        number: 100 + i,
        title: `Issue number ${100 + i} title`,
        state: 'OPEN' as const,
        labels: [{ name: 'ready-for-agent' }],
        created_at: '2026-08-19T10:00:00Z',
        updated_at: '2026-08-19T10:00:00Z',
        comments: 0,
      },
      status: 'ready' as const,
    }));

    // Render with selectedIndex = 18 (near the bottom)
    const { lastFrame } = render(
      <CategoryIssuesView
        categoryTitle="Ready for Agent"
        issues={issuesList}
        selectedIndex={18}
        repository="owner/test-repo"
      />
    );

    const output = lastFrame();
    expect(output).toContain('ISSUES: READY FOR AGENT');
    expect(output).toContain('Total: 25');
    // Issue #118 should be visible and selected
    expect(output).toContain('❯ #118');
    // Scroll indicator should show range
    expect(output).toContain('Showing');
    expect(output).toContain('of 25 issues');
  });

  it('should suggest /providers in CommandPalette when filtering by /prov', () => {
    const { lastFrame } = render(
      <MasterDashboard
        config={dummyConfig}
        dag={null}
        quotaStatus={null}
        workers={[]}
        selectedIndex={0}
        activityLogs={[]}
        commandInput="/prov"
        isCommandMode={true}
      />
    );

    const output = lastFrame();
    expect(output).toContain('COMMAND PALETTE');
    expect(output).toContain('/providers');
    expect(output).toContain('Toggle allowed LLM providers/runners');
  });

  it('should render ProvidersPickerView with provider list, status badges, and details', () => {
    const { lastFrame } = render(
      <ProvidersPickerView
        providers={[
          {
            id: 'claude',
            name: 'claude',
            displayName: 'Claude Code CLI (claude)',
            binaryName: 'claude',
            description: 'Anthropic Claude Code CLI agent runner',
            isInstalled: true,
            isAllowed: true,
            isDefault: true,
          },
          {
            id: 'agy',
            name: 'agy',
            displayName: 'Antigravity CLI (agy)',
            binaryName: 'agy',
            description: 'Google DeepMind Antigravity CLI agent runner',
            isInstalled: true,
            isAllowed: false,
            isDefault: false,
          },
          {
            id: 'pi',
            name: 'pi',
            displayName: 'Pi CLI (pi)',
            binaryName: 'pi',
            description: 'Inflection Pi CLI agent runner',
            isInstalled: false,
            isAllowed: false,
            isDefault: false,
          },
        ]}
        highlightedIndex={0}
        repository="owner/test-repo"
        configPath=".autopilot/config.json"
      />
    );

    const output = lastFrame();
    expect(output).toContain('LLM PROVIDERS & RUNNERS MANAGER');
    expect(output).toContain('Repo: owner/test-repo');
    expect(output).toContain('Config: .autopilot/config.json');
    expect(output).toContain('[x] Yes');
    expect(output).toContain('Claude Code CLI (claude)');
    expect(output).toContain('[default runner]');
    expect(output).toContain('● installed');
    expect(output).toContain('[ ] No');
    expect(output).toContain('Antigravity CLI (agy)');
    expect(output).toContain('○ not installed');
    expect(output).toContain('1 allowed (claude)');
    expect(output).toContain('[Space] Toggle Allowed');
    expect(output).toContain('[d] Set Default');
    expect(output).toContain('[a] Allow All Installed');
    expect(output).toContain('[Enter] Save');
    expect(output).toContain('[Esc] Back');
  });

  it('should render ProvidersPickerView with warning when all providers are disabled', () => {
    const { lastFrame } = render(
      <ProvidersPickerView
        providers={[
          {
            id: 'claude',
            name: 'claude',
            displayName: 'Claude Code CLI (claude)',
            binaryName: 'claude',
            description: 'Anthropic Claude Code CLI agent runner',
            isInstalled: true,
            isAllowed: false,
            isDefault: false,
          },
        ]}
        highlightedIndex={0}
        repository="owner/test-repo"
      />
    );

    const output = lastFrame();
    expect(output).toContain('No providers are currently allowed for this repository');
    expect(output).toContain('None (All disabled)');
  });

  it('should render allowed providers in MasterDashboard header when configured', () => {
    const configWithAllowed = {
      ...dummyConfig,
      allowedProviders: ['claude', 'agy'],
    };

    const { lastFrame } = render(
      <MasterDashboard
        config={configWithAllowed}
        dag={null}
        quotaStatus={null}
        workers={[]}
        selectedIndex={0}
        activityLogs={[]}
      />
    );

    const output = lastFrame();
    expect(output).toContain('Allowed: claude, agy');
  });

  it('should only render quota telemetry for allowed providers in MasterDashboard', () => {
    const configClaudeOnly = {
      ...dummyConfig,
      allowedProviders: ['claude'],
    };

    const quotaWithMultipleRunners = {
      isPaused: false,
      activePids: [],
      runnerUsage: {
        claude: {
          runnerName: 'claude',
          displayName: 'Claude Code CLI',
          buckets: [
            { name: 'Session 5h', group: 'Claude Models', windowType: 'five_hour' as const, usedPercentage: 45 },
          ],
          lastFetchedAt: new Date(),
        },
        agy: {
          runnerName: 'agy',
          displayName: 'Antigravity CLI',
          buckets: [
            { name: 'Gemini 5h', group: 'Gemini Models', windowType: 'five_hour' as const, usedPercentage: 20 },
          ],
          lastFetchedAt: new Date(),
        },
      },
    };

    const { lastFrame } = render(
      <MasterDashboard
        config={configClaudeOnly}
        dag={null}
        quotaStatus={quotaWithMultipleRunners}
        workers={[]}
        selectedIndex={0}
        activityLogs={[]}
      />
    );

    const output = lastFrame();
    expect(output).toContain('Claude Code CLI');
    expect(output).toContain('Session 5h');
    expect(output).not.toContain('Antigravity CLI');
    expect(output).not.toContain('Gemini 5h');
  });

  it('should only render telemetry cards for allowed providers in UsageView', () => {
    const quotaWithMultipleRunners = {
      isPaused: false,
      activePids: [],
      runnerUsage: {
        claude: {
          runnerName: 'claude',
          displayName: 'Claude Code CLI',
          buckets: [
            { name: 'Session 5h', group: 'Claude Models', windowType: 'five_hour' as const, usedPercentage: 45 },
          ],
          lastFetchedAt: new Date(),
        },
        agy: {
          runnerName: 'agy',
          displayName: 'Antigravity CLI',
          buckets: [
            { name: 'Gemini 5h', group: 'Gemini Models', windowType: 'five_hour' as const, usedPercentage: 20 },
          ],
          lastFetchedAt: new Date(),
        },
      },
    };

    const { lastFrame } = render(
      <UsageView
        quotaStatus={quotaWithMultipleRunners}
        repository="owner/test-repo"
        allowedProviders={['agy']}
      />
    );

    const output = lastFrame();
    expect(output).toContain('ANTIGRAVITY CLI TELEMETRY');
    expect(output).toContain('Gemini 5h');
    expect(output).not.toContain('CLAUDE CODE CLI TELEMETRY');
  });

  it('should render CategoryIssuesView with [e] Enqueue in footer and enqueue confirmation modal', () => {
    const issuesList = [
      {
        issue: {
          number: 77,
          title: 'Blocked Feature',
          body: '',
          state: 'OPEN' as const,
          labels: [{ name: 'ready-for-agent' }],
          url: 'https://github.com/owner/test-repo/issues/77',
          created_at: '2026-08-20T10:00:00Z',
          updated_at: '2026-08-20T10:00:00Z',
          comments: 0,
        },
        status: 'blocked' as const,
        blockers: [70],
      },
    ];

    const { lastFrame } = render(
      <CategoryIssuesView
        categoryTitle="Blocked Tasks"
        issues={issuesList}
        selectedIndex={0}
        confirmAction={{
          type: 'enqueue',
          issueNumber: 77,
          message: 'Issue #77 is blocked by #70 (open). Enqueue anyway?',
        }}
        repository="owner/test-repo"
      />
    );

    const output = lastFrame();
    expect(output).toContain('CONFIRM PRIORITY ENQUEUE: Issue #77');
    expect(output).toContain('Issue #77 is blocked by #70 (open). Enqueue anyway?');
    expect(output).toContain('[e] Enqueue');
    expect(output).toContain('Press [y] to confirm and enqueue, or [n] / [Esc] to cancel.');
  });

  it('should suggest /enqueue in CommandPalette when filtering by /enq', () => {
    const { lastFrame } = render(
      <MasterDashboard
        config={dummyConfig}
        dag={null}
        quotaStatus={null}
        workers={[]}
        selectedIndex={0}
        activityLogs={[]}
        commandInput="/enq"
        isCommandMode={true}
      />
    );

    const output = lastFrame();
    expect(output).toContain('COMMAND PALETTE');
    expect(output).toContain('/enqueue');
    expect(output).toContain('Queue an issue first');
  });

  it('should render Needs Triage section in MasterDashboard under Issue DAG Queue', () => {
    const mockDag: any = {
      getTargetSpecs: () => [],
      getReadyNodes: () => [{ issue: { number: 10 } }],
      getWaitingFeedbackNodes: () => [{ issue: { number: 20 } }],
      getBlockedNodes: () => [{ issue: { number: 30 }, blockers: [10] }],
      getTriageNodes: () => [{ issue: { number: 40 } }, { issue: { number: 41 } }],
    };

    const { lastFrame } = render(
      <MasterDashboard
        config={dummyConfig}
        dag={mockDag}
        quotaStatus={null}
        workers={[]}
        selectedIndex={4}
        activityLogs={[]}
      />
    );

    const output = lastFrame();
    expect(output).toContain('Issue DAG Queue:');
    expect(output).toContain('🟢 Ready for Agent:');
    expect(output).toContain('#10');
    expect(output).toContain('👤 Human Action:');
    expect(output).toContain('#20');
    expect(output).toContain('⚪ Blocked by Deps:');
    expect(output).toContain('#30');
    expect(output).toContain('📋 Needs Triage:');
    expect(output).toContain('2');
    expect(output).toContain('#40, #41');
  });

  it('should render CategoryIssuesView for triage backlog with pending status badge', () => {
    const issuesList = [
      {
        issue: {
          number: 40,
          title: 'Untriaged feature request',
          state: 'OPEN' as const,
          labels: [{ name: 'needs-triage' }],
          created_at: '2026-08-20T10:00:00Z',
          updated_at: '2026-08-20T10:00:00Z',
          comments: 0,
        },
        status: 'pending' as const,
      },
    ];

    const { lastFrame } = render(
      <CategoryIssuesView
        categoryTitle="Needs Triage (Triage Backlog)"
        issues={issuesList}
        selectedIndex={0}
        repository="owner/test-repo"
      />
    );

    const output = lastFrame();
    expect(output).toContain('ISSUES: NEEDS TRIAGE (TRIAGE BACKLOG)');
    expect(output).toContain('#40');
    expect(output).toContain('Untriaged feature request');
    expect(output).toContain('needs triage');
  });
});

