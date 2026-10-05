import React from 'react';
import { Box, Text } from 'ink';
import type { AutoPilotConfig, TaskStatus } from '../../types/index.js';
import { formatNodeBlockers, type IssueDAG } from '../../github/dag.js';
import { formatRepoLabel } from '../../config/schema.js';
import type { QuotaStatus } from '../../quota/monitor.js';
import { CommandPalette, type CommandResult } from './CommandPalette.js';

export interface WorkerItem {
  issueNumber: number;
  title: string;
  branchName: string;
  status: TaskStatus;
  startedAt?: Date;
  isWip?: boolean;
  runnerName?: string;
}

interface MasterDashboardProps {
  config: AutoPilotConfig;
  dag: IssueDAG | null;
  quotaStatus: QuotaStatus | null;
  workers: WorkerItem[];
  selectedIndex: number;
  activityLogs: string[];
  commandInput?: string;
  isCommandMode?: boolean;
  commandResult?: CommandResult | null;
  selectedCommandIndex?: number;
  isSessionStarted?: boolean;
}

export const MasterDashboard: React.FC<MasterDashboardProps> = ({
  config,
  dag,
  quotaStatus,
  workers,
  selectedIndex,
  activityLogs,
  commandInput = '',
  isCommandMode = false,
  commandResult = null,
  selectedCommandIndex = 0,
  isSessionStarted = true,
}) => {
  const targetSpecs = dag ? dag.getTargetSpecs() : [];
  let specContext = '';
  if (targetSpecs.length === 1) {
    specContext = ` | Spec: #${targetSpecs[0]}`;
  } else if (targetSpecs.length > 1) {
    specContext = ` | Specs: ${targetSpecs.map((s) => `#${s}`).join(', ')}`;
  } else {
    specContext = ` | Scope: Any Spec (All Tasks)`;
  }
  const repoLabel = formatRepoLabel(config);
  const repoContext = repoLabel ? ` | Repo: ${repoLabel}` : '';

  const configuredAllowed = config.allowedProviders || config.allowedRunners;
  const isRunnerAllowed = (runnerName: string) => {
    if (!configuredAllowed || configuredAllowed.length === 0) return true;
    return configuredAllowed.map((p) => p.toLowerCase()).includes(runnerName.toLowerCase());
  };

  const renderQuotaBar = () => {
    if (!quotaStatus) {
      return <Text color="green">● Quota Status: Normal</Text>;
    }

    const isPausedRunnerAllowed = quotaStatus.pausedRunner ? isRunnerAllowed(quotaStatus.pausedRunner) : true;
    const pauseBanner = (quotaStatus.isPaused && quotaStatus.resetAt && isPausedRunnerAllowed) ? (
      <Box flexDirection="column" marginBottom={0}>
        <Text backgroundColor="red" color="white" bold>
          {` ⏳ ${quotaStatus.pausedRunner ? quotaStatus.pausedRunner.toUpperCase() + ' ' : ''}${quotaStatus.reason?.toLowerCase().includes('threshold') ? 'THRESHOLD LIMIT PAUSED' : 'QUOTA LIMIT PAUSED'} `}
        </Text>
        <Text color="red">
          {`Resumes automatically at ${quotaStatus.resetAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (~${Math.ceil(Math.max(0, quotaStatus.resetAt.getTime() - Date.now()) / (60 * 1000))}m) or on manual resume`}
        </Text>
      </Box>
    ) : null;

    let telemetryBars: React.ReactNode = null;

    if (quotaStatus.runnerUsage && Object.keys(quotaStatus.runnerUsage).length > 0) {
      const allowedUsages = Object.values(quotaStatus.runnerUsage).filter((rUsage) =>
        isRunnerAllowed(rUsage.runnerName)
      );

      if (allowedUsages.length > 0) {
        telemetryBars = (
          <Box flexDirection="column">
            {allowedUsages.map((rUsage) => {
              return (
                <Box key={rUsage.runnerName} flexDirection="row" marginBottom={0}>
                  <Text bold color={rUsage.runnerName === 'agy' ? 'blue' : 'cyan'}>
                    {`● ${rUsage.displayName}: `}
                  </Text>
                  {rUsage.buckets.map((b, i) => {
                    const barLen = 8;
                    const filled = Math.min(barLen, Math.round((b.usedPercentage / 100) * barLen));
                    const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, barLen - filled));
                    const color = b.usedPercentage >= 95 ? 'red' : b.usedPercentage >= 80 ? 'yellow' : 'green';
                    return (
                      <Text key={i} color={color}>
                        {i > 0 ? '  ' : ''}{b.name}: [{bar}] {b.usedPercentage}%
                      </Text>
                    );
                  })}
                </Box>
              );
            })}
          </Box>
        );
      } else if (!pauseBanner) {
        telemetryBars = <Text color="green">● Quota Status: Normal (headroom healthy)</Text>;
      }
    } else if (quotaStatus.liveUsage && isRunnerAllowed('claude')) {
      const live = quotaStatus.liveUsage;
      const sessPct = live.sessionUsedPercentage;
      const barLen = 12;
      const sessFilled = Math.min(barLen, Math.max(0, Math.round((sessPct / 100) * barLen)));
      const sessBar = '█'.repeat(sessFilled) + '░'.repeat(Math.max(0, barLen - sessFilled));
      const sessColor = sessPct >= 100 ? 'red' : sessPct >= 80 ? 'yellow' : 'green';

      telemetryBars = (
        <Box flexDirection="column">
          <Text color={sessColor}>
            ● 5h Session Quota: [{sessBar}] {sessPct}% used
            {live.sessionResetText ? ` · Resets ${live.sessionResetText}` : ''}
          </Text>
          {live.weekUsedPercentage !== undefined && (
            <Text color={live.weekUsedPercentage >= 90 ? 'red' : 'cyan'}>
              ● Weekly Quota:    [{'█'.repeat(Math.min(12, Math.round((live.weekUsedPercentage / 100) * 12))) + '░'.repeat(Math.max(0, 12 - Math.round((live.weekUsedPercentage / 100) * 12)))}] {live.weekUsedPercentage}% used
            </Text>
          )}
        </Box>
      );
    } else if (!pauseBanner) {
      telemetryBars = <Text color="green">● Quota Status: Normal (headroom healthy)</Text>;
    }

    return (
      <Box flexDirection="column">
        {pauseBanner}
        {telemetryBars}
      </Box>
    );
  };

  const renderStatusBadge = (worker: WorkerItem) => {
    if (worker.isWip) {
      if (worker.status === 'paused_quota') {
        return <Text color="yellow">⏳ paused (quota)</Text>;
      }
      if (worker.status === 'waiting_feedback') {
        return <Text color="magenta">👀 in review</Text>;
      }
      if (worker.status === 'blocked') {
        return <Text color="gray">⏳ blocked</Text>;
      }
      return <Text color="cyan">⏳ waiting (WIP)</Text>;
    }
    switch (worker.status) {
      case 'running':
        return <Text color="cyan">⚡ running</Text>;
      case 'testing':
        return <Text color="magenta">🧪 testing</Text>;
      case 'merging':
        return <Text color="yellow">🔀 merging</Text>;
      case 'paused_quota':
        return <Text color="red">⏳ paused</Text>;
      case 'waiting_feedback':
        return <Text color="yellow">👀 in review</Text>;
      default:
        return <Text color="gray">{worker.status}</Text>;
    }
  };

  const renderElapsed = (worker: WorkerItem) => {
    if (worker.isWip) {
      return <Text color="gray">preserves WIP</Text>;
    }
    if (!worker.startedAt) return <Text color="gray">-</Text>;
    const sec = Math.floor((Date.now() - worker.startedAt.getTime()) / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return <Text color="gray">{m}m {s}s</Text>;
  };

  const readyNodes = dag ? dag.getReadyNodes() : [];
  const waitingNodes = dag ? dag.getWaitingFeedbackNodes() : [];
  const blockedNodes = dag ? dag.getBlockedNodes() : [];
  const triageNodes = dag ? dag.getTriageNodes() : [];

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      {/* Header Banner */}
      <Box flexDirection="column" marginBottom={1}>
        <Box flexDirection="row">
          <Text backgroundColor="cyan" color="black" bold>
            {' ⚡ AGENT AUTO-PILOT '}
          </Text>
          <Text color="cyan">
            {repoContext}{specContext}
          </Text>
        </Box>
        <Text color="gray">
          Default Runner: {config.runner}{config.allowedProviders ? ` | Allowed: ${config.allowedProviders.length > 0 ? config.allowedProviders.join(', ') : 'none'}` : ''} | Concurrency: {workers.filter((w) => !w.isWip).length}/{config.maxConcurrency}
        </Text>
      </Box>

      {/* Quota Telemetry */}
      <Box marginBottom={1}>
        {renderQuotaBar()}
      </Box>

      {/* Worker Selection Table */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="white">
          Active &amp; Paused Agent Worktrees:
        </Text>
        {workers.length === 0 ? (
          <Text color="gray">  No active agent workers running (Idle)</Text>
        ) : (
          <Box flexDirection="column">
            <Box flexDirection="row" marginBottom={0}>
              <Box width={9}>
                <Text bold color="cyan">Issue</Text>
              </Box>
              <Box width={9}>
                <Text bold color="cyan">Runner</Text>
              </Box>
              <Box width={26}>
                <Text bold color="cyan">Title</Text>
              </Box>
              <Box width={24}>
                <Text bold color="cyan">Branch</Text>
              </Box>
              <Box width={16}>
                <Text bold color="cyan">Status</Text>
              </Box>
              <Box width={14}>
                <Text bold color="cyan">Elapsed</Text>
              </Box>
            </Box>
            {workers.map((worker, index) => {
              const isSelected = index === selectedIndex;
              const prefix = isSelected ? '❯ ' : '  ';
              const issueStr = `${prefix}#${worker.issueNumber}`;
              const runnerStr = worker.runnerName || config.runner;
              const titleStr = worker.title.length > 24 ? `${worker.title.slice(0, 21)}...` : worker.title;
              const branchStr = worker.branchName.length > 22 ? `${worker.branchName.slice(0, 19)}...` : worker.branchName;

              return (
                <Box key={worker.issueNumber} flexDirection="row">
                  <Box width={9}>
                    <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
                      {issueStr}
                    </Text>
                  </Box>
                  <Box width={9}>
                    <Text color={runnerStr === 'agy' ? 'blue' : 'cyan'}>
                      {runnerStr}
                    </Text>
                  </Box>
                  <Box width={26}>
                    <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
                      {titleStr}
                    </Text>
                  </Box>
                  <Box width={24}>
                    <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
                      {branchStr}
                    </Text>
                  </Box>
                  <Box width={16}>
                    {renderStatusBadge(worker)}
                  </Box>
                  <Box width={14}>
                    {renderElapsed(worker)}
                  </Box>
                </Box>
              );
            })}
          </Box>
        )}
      </Box>

      {/* DAG Queue Summary */}
      <Box flexDirection="column" marginBottom={1}>
        <Box flexDirection="row">
          <Text bold color="white">
            Issue DAG Queue:
          </Text>
          <Text color="gray"> (highlight &amp; press [Enter] to inspect issues)</Text>
        </Box>

        {/* 1. Scoped Specs / All Specs Row */}
        <Box flexDirection="row">
          <Box width={26}>
            <Text
              color={selectedIndex === workers.length ? 'cyan' : 'cyan'}
              bold={selectedIndex === workers.length}
            >
              {selectedIndex === workers.length ? '❯ ' : '  '}
              {targetSpecs.length > 0 ? '🎯 Scoped Specs:' : '🎯 All Specs (Any):'}
            </Text>
          </Box>
          <Box width={6}>
            <Text bold color={selectedIndex === workers.length ? 'cyan' : 'white'}>
              {targetSpecs.length > 0 ? targetSpecs.length : 'All'}
            </Text>
          </Box>
          <Text color={selectedIndex === workers.length ? 'cyan' : 'gray'}>
            {targetSpecs.length > 0 ? targetSpecs.map((s) => `#${s}`).join(', ') : 'Resolving all ready tasks'}
          </Text>
        </Box>

        {/* 2. Ready for Agent Row */}
        <Box flexDirection="row">
          <Box width={26}>
            <Text
              color={selectedIndex === workers.length + 1 ? 'cyan' : 'green'}
              bold={selectedIndex === workers.length + 1}
            >
              {selectedIndex === workers.length + 1 ? '❯ ' : '  '}🟢 Ready for Agent:
            </Text>
          </Box>
          <Box width={6}>
            <Text bold color={selectedIndex === workers.length + 1 ? 'cyan' : 'green'}>
              {readyNodes.length}
            </Text>
          </Box>
          <Text color={selectedIndex === workers.length + 1 ? 'cyan' : 'gray'}>
            {readyNodes.map((n) => `#${n.issue.number}`).join(', ') || 'None'}
          </Text>
        </Box>

        {/* 3. Human Action Required Row */}
        <Box flexDirection="row">
          <Box width={26}>
            <Text
              color={selectedIndex === workers.length + 2 ? 'cyan' : 'yellow'}
              bold={selectedIndex === workers.length + 2}
            >
              {selectedIndex === workers.length + 2 ? '❯ ' : '  '}👤 Human Action:
            </Text>
          </Box>
          <Box width={6}>
            <Text bold color={selectedIndex === workers.length + 2 ? 'cyan' : 'yellow'}>
              {waitingNodes.length}
            </Text>
          </Box>
          <Text color={selectedIndex === workers.length + 2 ? 'cyan' : 'gray'}>
            {waitingNodes.map((n) => `#${n.issue.number}`).join(', ') || 'None'}
          </Text>
        </Box>

        {/* 4. Blocked by Deps Row */}
        <Box flexDirection="row">
          <Box width={26}>
            <Text
              color={selectedIndex === workers.length + 3 ? 'cyan' : 'gray'}
              bold={selectedIndex === workers.length + 3}
            >
              {selectedIndex === workers.length + 3 ? '❯ ' : '  '}⚪ Blocked by Deps:
            </Text>
          </Box>
          <Box width={6}>
            <Text bold color={selectedIndex === workers.length + 3 ? 'cyan' : 'gray'}>
              {blockedNodes.length}
            </Text>
          </Box>
          <Text color={selectedIndex === workers.length + 3 ? 'cyan' : 'gray'}>
            {blockedNodes.map((n) => `#${n.issue.number} (blocked by ${formatNodeBlockers(n).join(', ')})`).join(', ') || 'None'}
          </Text>
        </Box>

        {/* 5. Needs Triage Row */}
        <Box flexDirection="row">
          <Box width={26}>
            <Text
              color={selectedIndex === workers.length + 4 ? 'cyan' : 'magenta'}
              bold={selectedIndex === workers.length + 4}
            >
              {selectedIndex === workers.length + 4 ? '❯ ' : '  '}📋 Needs Triage:
            </Text>
          </Box>
          <Box width={6}>
            <Text bold color={selectedIndex === workers.length + 4 ? 'cyan' : 'magenta'}>
              {triageNodes.length}
            </Text>
          </Box>
          <Text color={selectedIndex === workers.length + 4 ? 'cyan' : 'gray'}>
            {triageNodes.map((n) => `#${n.issue.number}`).join(', ') || 'None'}
          </Text>
        </Box>
      </Box>

      {/* Recent Activity Snapshot (Strictly capped to 3 single-line entries) */}
      <Box flexDirection="column" marginBottom={1}>
        <Box flexDirection="row">
          <Text
            bold={selectedIndex === workers.length + 5}
            color={selectedIndex === workers.length + 5 ? 'cyan' : 'white'}
          >
            {selectedIndex === workers.length + 5 ? '❯ ' : '  '}📜 Recent Activity:
          </Text>
          <Text color={selectedIndex === workers.length + 5 ? 'cyan' : 'gray'}>
            {' '}(press [Enter] or type /logs for full log history)
          </Text>
        </Box>
        {activityLogs.length === 0 ? (
          <Text color="gray">  Waiting for events...</Text>
        ) : (
          activityLogs.slice(-3).map((line, idx) => {
            const truncated = line.length > 90 ? `${line.slice(0, 87)}...` : line;
            return (
              <Text key={idx} color="gray">
                {'  '}{truncated}
              </Text>
            );
          })
        )}
      </Box>

      {/* Command Palette & Footer */}
      <CommandPalette
        commandInput={commandInput}
        isCommandMode={isCommandMode}
        commandResult={commandResult}
        selectedCommandIndex={selectedCommandIndex}
      />
    </Box>
  );
};
