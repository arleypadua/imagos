import React from 'react';
import { Box, Text } from 'ink';
import type { QuotaStatus, RunnerLiveUsage } from '../../quota/types.js';

interface UsageViewProps {
  quotaStatus: QuotaStatus | null;
  repository?: string;
  allowedProviders?: string[];
  isRefreshing?: boolean;
}

export const UsageView: React.FC<UsageViewProps> = ({
  quotaStatus,
  repository,
  allowedProviders,
  isRefreshing = false,
}) => {
  const isRunnerAllowed = (runnerName: string) => {
    if (!allowedProviders || allowedProviders.length === 0) return true;
    return allowedProviders.map((p) => p.toLowerCase()).includes(runnerName.toLowerCase());
  };

  const renderProgressBar = (pct: number, length: number = 20) => {
    const filled = Math.min(length, Math.max(0, Math.round((pct / 100) * length)));
    const empty = Math.max(0, length - filled);
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    const color = pct >= 95 ? 'red' : pct >= 80 ? 'yellow' : 'green';
    return <Text color={color}>[{bar}] {pct}%</Text>;
  };

  const isPaused = Boolean(quotaStatus?.isPaused);
  const resetAt = quotaStatus?.resetAt;
  const runnerUsage = quotaStatus?.runnerUsage;

  const remainingMins = resetAt
    ? Math.max(0, Math.ceil((resetAt.getTime() - Date.now()) / (60 * 1000)))
    : null;

  const renderRunnerCard = (runner: RunnerLiveUsage) => {
    const isAgy = runner.runnerName === 'agy';
    const borderColor = isAgy ? 'blue' : 'cyan';

    return (
      <Box key={runner.runnerName} flexDirection="column" borderStyle="single" borderColor={borderColor} paddingX={1} marginBottom={1}>
        <Box flexDirection="row" marginBottom={0}>
          <Text bold color={isAgy ? 'blue' : 'cyan'}>
            {`⚡ ${runner.displayName.toUpperCase()} TELEMETRY`}
          </Text>
        </Box>

        {runner.buckets.map((bucket, idx) => {
          const resetLabel = bucket.resetText
            ? ` · Resets: ${bucket.resetText}`
            : bucket.resetAt
            ? ` · Resets: ${bucket.resetAt.toLocaleTimeString()}`
            : '';

          return (
            <Box key={idx} flexDirection="column" marginTop={idx > 0 ? 1 : 0}>
              <Text bold color="white">
                {bucket.name}:
              </Text>
              <Box flexDirection="row">
                <Box width={32}>
                  {renderProgressBar(bucket.usedPercentage, 20)}
                </Box>
                <Text color="gray">
                  {bucket.remainingPercentage !== undefined ? `${bucket.remainingPercentage}% remaining` : `${bucket.usedPercentage}% used`}
                  {resetLabel}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    );
  };

  const allowedRunnerUsages = runnerUsage && Object.keys(runnerUsage).length > 0
    ? Object.values(runnerUsage).filter((r) => isRunnerAllowed(r.runnerName))
    : [];

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      {/* Header Banner */}
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
        <Box flexDirection="row">
          <Text backgroundColor="cyan" color="black" bold>
            {' 📊 LLM RUNNER QUOTA & SCHEDULED WAKE-UP TELEMETRY '}
          </Text>
          {repository && (
            <Text color="gray"> | Repo: {repository}</Text>
          )}
        </Box>
        <Text color="gray">
          Live telemetry stream synced directly with CLI runner tools (/usage)
        </Text>
      </Box>

      {/* Runner Telemetry Cards */}
      {allowedRunnerUsages.length > 0 ? (
        allowedRunnerUsages.map(renderRunnerCard)
      ) : quotaStatus?.liveUsage && isRunnerAllowed('claude') ? (
        <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1} marginBottom={1}>
          <Text bold color="cyan">
            ⚡ CLAUDE CODE CLI TELEMETRY
          </Text>
          {[
            ...(quotaStatus.liveUsage.sessionUsedPercentage !== undefined
              ? [{ label: '5-Hour Session Quota:', pct: quotaStatus.liveUsage.sessionUsedPercentage, resetText: quotaStatus.liveUsage.sessionResetText }]
              : []),
            ...(quotaStatus.liveUsage.weekUsedPercentage !== undefined
              ? [{ label: 'Weekly Account Quota:', pct: quotaStatus.liveUsage.weekUsedPercentage, resetText: quotaStatus.liveUsage.weekResetText }]
              : []),
            ...(quotaStatus.liveUsage.modelWeeks ?? []).map((mw) => ({
              label: `Weekly ${mw.model} Quota:`,
              pct: mw.usedPercentage,
              resetText: mw.resetText,
            })),
          ].map((row, i) => (
            <Box key={row.label} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
              <Text bold color="white">{row.label}</Text>
              <Box flexDirection="row">
                <Box width={32}>{renderProgressBar(row.pct, 20)}</Box>
                {row.resetText && <Text color="gray">Resets: {row.resetText}</Text>}
              </Box>
            </Box>
          ))}
        </Box>
      ) : (
        <Box borderStyle="single" borderColor="green" paddingX={1} marginBottom={1}>
          <Text color="green">● All runner quotas healthy (ample headroom remaining)</Text>
        </Box>
      )}

      {/* Scheduled Wake-Up & Daemon Pause Status */}
      <Box flexDirection="column" borderStyle="round" borderColor={isPaused ? 'yellow' : 'green'} paddingX={1} marginBottom={1}>
        <Text bold color={isPaused ? 'yellow' : 'green'}>
          {isPaused
            ? `⏳ ${quotaStatus?.pausedRunner ? quotaStatus.pausedRunner.toUpperCase() + ' ' : ''}${quotaStatus?.reason?.toLowerCase().includes('threshold') ? 'THRESHOLD LIMIT' : 'QUOTA LIMIT'} (PAUSED)`
            : '✅ WAKE-UP STATUS (HEALTHY)'}
        </Text>
        {isPaused && resetAt ? (
          <Box flexDirection="column">
            <Text color="yellow" bold>
              Resumes automatically at: {resetAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (~{remainingMins}m) or on manual resume
            </Text>
            <Text color="gray">
              Reason: {quotaStatus?.reason || 'Runner quota limit reached'}
            </Text>
            <Text color="gray">
              Action: Tasks using {quotaStatus?.pausedRunner || 'the paused runner'} are suspended until reset or manual resume.
            </Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text color="green">
              No pause scheduled. The daemon is actively processing issues up to max concurrency.
            </Text>
          </Box>
        )}
      </Box>

      {/* Telemetry Metadata */}
      <Box flexDirection="row" marginBottom={1}>
        <Text color="gray">
          Last Synced: {new Date().toLocaleTimeString()}
          {isRefreshing ? ' (refreshing...)' : ''}  •  Active PIDs: {quotaStatus?.activePids.length || 0}
        </Text>
      </Box>

      {/* Footer Navigation */}
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text color="cyan">
          [Esc] Back to Main Dashboard  •  [r] Refresh Telemetry
        </Text>
      </Box>
    </Box>
  );
};
