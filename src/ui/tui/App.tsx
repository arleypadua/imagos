import React, { useState, useEffect } from 'react';
import { useInput, useApp } from 'ink';
import {
  ENQUEUE_EXAMPLES,
  ENQUEUE_SUMMARY,
  ENQUEUE_USAGE,
  formatEnqueueFlagLines,
  parseEnqueueArgs,
} from '../../pipeline/enqueue_help.js';
import { Orchestrator } from '../../pipeline/orchestrator.js';
import { AgentEventBus, type AgentEvent } from '../../events/bus.js';
import { loadHistoricalEvents } from '../../events/history.js';
import type { TaskStatus } from '../../types/index.js';
import { MasterDashboard, type WorkerItem } from './MasterDashboard.js';
import { InspectView } from './InspectView.js';
import { UsageView } from './UsageView.js';
import { SpecPickerView, type SpecOption } from './SpecPickerView.js';
import { ActivityLogView } from './ActivityLogView.js';
import { CategoryIssuesView, type CategoryIssueItem } from './CategoryIssuesView.js';
import { ProvidersPickerView } from './ProvidersPickerView.js';
import { IssueBrowserView, type FlatTreeItem } from './IssueBrowserView.js';
import { AVAILABLE_COMMANDS, type CommandResult } from './CommandPalette.js';
import type { ProviderInfo } from '../../types/index.js';

interface AppProps {
  orchestrator: Orchestrator;
  onExit?: () => void;
}

export const App: React.FC<AppProps> = ({ orchestrator, onExit }) => {
  const { exit } = useApp();
  const [view, setView] = useState<'dashboard' | 'inspect' | 'usage' | 'spec_picker' | 'logs' | 'category_issues' | 'providers' | 'issue_browser'>('dashboard');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [inspectIssueNumber, setInspectIssueNumber] = useState<number | null>(null);
  const [inputText, setInputText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | undefined>(undefined);
  const [eventsMap, setEventsMap] = useState<Map<number, AgentEvent[]>>(new Map());
  const [tickCount, setTickCount] = useState(0);
  const [isRefreshingUsage, setIsRefreshingUsage] = useState(false);
  const [highlightedSpecIndex, setHighlightedSpecIndex] = useState(0);
  const [selectedSpecNumbers, setSelectedSpecNumbers] = useState<Set<number>>(new Set());
  const [isAllTasksSelected, setIsAllTasksSelected] = useState(false);
  const [logScrollOffset, setLogScrollOffset] = useState(0);

  // Providers View State
  const [providersList, setProvidersList] = useState<ProviderInfo[]>([]);
  const [highlightedProviderIndex, setHighlightedProviderIndex] = useState(0);
  const [providersStatusMessage, setProvidersStatusMessage] = useState<string | undefined>(undefined);

  // Category Issues View State
  const [selectedCategory, setSelectedCategory] = useState<'specs' | 'ready' | 'waiting' | 'blocked' | 'triage'>('ready');
  const [categoryItemIndex, setCategoryItemIndex] = useState(0);
  const [confirmAction, setConfirmAction] = useState<{ type: 'kill' | 'pause' | 'enqueue'; issueNumber: number; message?: string } | null>(null);
  const [categoryStatusMessage, setCategoryStatusMessage] = useState<string | undefined>(undefined);

  // Issue Browser View State
  const [browserIndex, setBrowserIndex] = useState(0);
  const [expandedSpecs, setExpandedSpecs] = useState<Set<number>>(new Set());
  const [browserConfirmAction, setBrowserConfirmAction] = useState<{ type: 'kill' | 'pause' | 'enqueue'; issueNumber: number; message?: string } | null>(null);
  const [browserStatusMessage, setBrowserStatusMessage] = useState<string | undefined>(undefined);
  const [showOnlyOpen, setShowOnlyOpen] = useState(false);

  // Command Palette State
  const [commandInput, setCommandInput] = useState('');
  const [isCommandMode, setIsCommandMode] = useState(false);
  const [commandResult, setCommandResult] = useState<CommandResult | null>(null);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);

  const eventBus = AgentEventBus.getInstance();
  const config = orchestrator.getConfig();
  const dag = orchestrator.getDAG();
  const quotaStatus = orchestrator.getQuotaMonitor().getStatus();
  const dashboard = orchestrator.getDashboard();
  const activeWorkersMap = dashboard.getActiveWorkers();
  const activityLogs = dashboard.getLogs();
  const isSessionStarted = orchestrator.isStarted();

  // Combine actively executing workers and WIP worktrees on disk
  const buildWorkerList = (): WorkerItem[] => {
    const list: WorkerItem[] = [];
    const renderedIssues = new Set<number>();

    // 1. Actively executing workers
    for (const worker of activeWorkersMap.values()) {
      renderedIssues.add(worker.issueNumber);
      const session = orchestrator.getStateManager().getSession(worker.issueNumber);
      const node = dag ? dag.getNode(worker.issueNumber) : undefined;
      const runnerName = worker.runnerName || session?.metadata?.runner || node?.runnerName || config.runner;

      list.push({
        issueNumber: worker.issueNumber,
        title: worker.title,
        branchName: worker.branchName,
        status: worker.status,
        startedAt: worker.startedAt,
        isWip: false,
        runnerName,
      });
    }

    // 2. Add WIP / Paused worktrees on disk waiting to resume
    const existingWorktrees = orchestrator.getActiveWorktrees();
    for (const wt of existingWorktrees) {
      if (wt.issueNumber && !renderedIssues.has(wt.issueNumber)) {
        const node = dag ? dag.getNode(wt.issueNumber) : undefined;
        if (node && node.issue.state === 'OPEN') {
          renderedIssues.add(wt.issueNumber);
          const session = orchestrator.getStateManager().getSession(wt.issueNumber);
          const runnerName = node.runnerName || session?.metadata?.runner || config.runner;
          const isRunnerPaused = orchestrator.getQuotaMonitor().isRunnerPaused(runnerName);

          let status: TaskStatus = 'pending';
          if (node.status === 'waiting_feedback' || session?.metadata?.status === 'waiting_feedback') {
            status = 'waiting_feedback';
          } else if (node.status === 'blocked') {
            status = 'blocked';
          } else if (isRunnerPaused) {
            status = 'paused_quota';
          }

          list.push({
            issueNumber: wt.issueNumber,
            title: node.issue.title,
            branchName: wt.branch,
            status,
            isWip: true,
            runnerName,
          });
        }
      }
    }

    return list;
  };

  const workers = buildWorkerList();

  const buildSpecOptions = (): SpecOption[] => {
    const options: SpecOption[] = [];
    const workersMap = new Map(workers.map((w) => [w.issueNumber, w]));
    if (dag) {
      const specNodes = dag.getAllNodes().filter((n) => n.kind === 'spec' && n.issue.state === 'OPEN');
      for (const specNode of specNodes) {
        const comp = dag.isSpecComplete(specNode.issue.number);
        options.push({
          number: specNode.issue.number,
          title: specNode.issue.title,
          childCount: comp.totalTickets,
          completedCount: comp.completedTickets,
          worker: workersMap.get(specNode.issue.number),
          blockers: specNode.blockers,
          labels: specNode.issue.labels?.map((l) => l.name),
          status: specNode.status,
          issue: specNode.issue,
        });
      }
    }
    options.push({
      title: 'Any unblocked task (all ready-for-agent issues)',
      isAllTasks: true,
    });
    return options;
  };

  const specOptions = buildSpecOptions();

  const buildCategoryIssues = (category: 'specs' | 'ready' | 'waiting' | 'blocked' | 'triage'): CategoryIssueItem[] => {
    if (!dag) return [];
    const items: CategoryIssueItem[] = [];
    const workersMap = new Map(workers.map((w) => [w.issueNumber, w]));

    if (category === 'ready') {
      for (const node of dag.getReadyNodes()) {
        items.push({
          issue: node.issue,
          status: node.status,
          blockers: node.blockers,
          parentNumber: node.parentNumber,
          worker: workersMap.get(node.issue.number),
        });
      }
    } else if (category === 'waiting') {
      for (const node of dag.getWaitingFeedbackNodes()) {
        items.push({
          issue: node.issue,
          status: node.status,
          blockers: node.blockers,
          parentNumber: node.parentNumber,
          worker: workersMap.get(node.issue.number),
        });
      }
    } else if (category === 'blocked') {
      for (const node of dag.getBlockedNodes()) {
        items.push({
          issue: node.issue,
          status: node.status,
          blockers: node.blockers,
          parentNumber: node.parentNumber,
          worker: workersMap.get(node.issue.number),
        });
      }
    } else if (category === 'triage') {
      for (const node of dag.getTriageNodes()) {
        items.push({
          issue: node.issue,
          status: node.status,
          blockers: node.blockers,
          parentNumber: node.parentNumber,
          worker: workersMap.get(node.issue.number),
        });
      }
    } else if (category === 'specs') {
      const targetSpecs = dag.getTargetSpecs();
      const specNodes = dag.getAllNodes().filter((n) =>
        targetSpecs.length > 0 ? targetSpecs.includes(n.issue.number) : n.kind === 'spec'
      );
      for (const node of specNodes) {
        items.push({
          issue: node.issue,
          status: node.status,
          blockers: node.blockers,
          worker: workersMap.get(node.issue.number),
        });
      }
    }
    return items;
  };

  const getCategoryTitle = (cat: 'specs' | 'ready' | 'waiting' | 'blocked' | 'triage'): string => {
    switch (cat) {
      case 'specs':
        return dag && dag.getTargetSpecs().length > 0 ? 'Scoped Specifications' : 'All Specifications';
      case 'ready':
        return 'Ready for Agent';
      case 'waiting':
        return 'Human Action Required (Tasks & Feedback)';
      case 'blocked':
        return 'Blocked by Dependencies';
      case 'triage':
        return 'Needs Triage (Triage Backlog)';
    }
  };

  const buildTreeItems = (
    expanded: Set<number>,
    onlyOpen: boolean = false,
  ): { items: FlatTreeItem[]; totalSpecsCount: number; totalStandaloneCount: number } => {
    if (!dag) return { items: [], totalSpecsCount: 0, totalStandaloneCount: 0 };
    const allNodes = dag.getAllNodes();
    const workersMap = new Map(workers.map((w) => [w.issueNumber, w]));
    const items: FlatTreeItem[] = [];

    // 1. Open Specifications
    const openSpecNodes = allNodes.filter((n) => n.kind === 'spec' && n.issue.state === 'OPEN');
    const childAssignedNumbers = new Set<number>();

    for (const specNode of openSpecNodes) {
      const comp = dag.isSpecComplete(specNode.issue.number);
      const isExpanded = expanded.has(specNode.issue.number);
      const childNumbers = dag.getSpecChildIssueNumbers(specNode.issue.number);

      items.push({
        type: 'spec',
        number: specNode.issue.number,
        title: specNode.issue.title,
        status: specNode.status,
        isComplete: comp.isComplete,
        totalTickets: comp.totalTickets,
        completedTickets: comp.completedTickets,
        isExpanded,
        worker: workersMap.get(specNode.issue.number),
        blockers: specNode.blockers,
        labels: specNode.issue.labels?.map((l) => l.name),
        issue: specNode.issue,
      });

      if (isExpanded && childNumbers.length > 0) {
        const visibleChildNumbers = onlyOpen
          ? childNumbers.filter((childId) => {
              const childNode = dag.getNode(childId);
              return childNode && childNode.issue.state !== 'CLOSED';
            })
          : childNumbers;

        visibleChildNumbers.forEach((childId, idx) => {
          childAssignedNumbers.add(childId);
          const childNode = dag.getNode(childId);
          const isClosed = !childNode || childNode.issue.state === 'CLOSED';
          const isLast = idx === visibleChildNumbers.length - 1;
          items.push({
            type: 'child',
            number: childId,
            title: childNode?.issue.title || `Issue #${childId}`,
            status: isClosed ? 'completed' : childNode?.status || 'pending',
            state: childNode?.issue.state || (isClosed ? 'CLOSED' : 'OPEN'),
            isClosed,
            parentSpecNumber: specNode.issue.number,
            isLast,
            worker: workersMap.get(childId),
            blockers: childNode?.blockers,
            labels: childNode?.issue.labels?.map((l) => l.name),
            issue: childNode?.issue,
          });
        });
      } else {
        for (const childId of childNumbers) {
          childAssignedNumbers.add(childId);
        }
      }
    }

    // 2. Standalone Open Issues (not specs, not children of any open spec)
    const specNumbers = new Set(allNodes.filter((n) => n.kind === 'spec').map((n) => n.issue.number));
    const standaloneNodes = allNodes.filter(
      (n) =>
        n.issue.state === 'OPEN' &&
        !specNumbers.has(n.issue.number) &&
        !childAssignedNumbers.has(n.issue.number) &&
        n.parentNumber === undefined
    );

    for (const node of standaloneNodes) {
      items.push({
        type: 'standalone',
        number: node.issue.number,
        title: node.issue.title,
        status: node.status,
        worker: workersMap.get(node.issue.number),
        blockers: node.blockers,
        labels: node.issue.labels?.map((l) => l.name),
        issue: node.issue,
      });
    }

    return {
      items,
      totalSpecsCount: openSpecNodes.length,
      totalStandaloneCount: standaloneNodes.length,
    };
  };

  // Listen to orchestrator ticks and 1-second refresh timer
  useEffect(() => {
    const unsubscribe = orchestrator.onTick(() => {
      setTickCount((prev) => prev + 1);
    });

    const timer = setInterval(() => {
      setTickCount((prev) => prev + 1);
    }, 1000);

    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [orchestrator]);

  // Listen to AgentEventBus for live streaming tool calls & thoughts
  useEffect(() => {
    const onAgentEvent = (event: AgentEvent) => {
      setEventsMap((prev) => {
        const next = new Map(prev);
        const list = next.get(event.issueNumber) || [...eventBus.getHistory(event.issueNumber)];
        if (!list.some((e) => e.id === event.id)) {
          list.push(event);
        }
        next.set(event.issueNumber, list.slice(-100));
        return next;
      });
    };

    eventBus.on('agent_event', onAgentEvent);
    return () => {
      eventBus.off('agent_event', onAgentEvent);
    };
  }, [eventBus]);

  const handleQuit = async () => {
    try {
      await orchestrator.stop();
    } catch {}
    if (onExit) {
      onExit();
    } else {
      process.exit(0);
    }
  };

  const handleExecuteCommand = async (rawCmd: string) => {
    const cmd = rawCmd.trim().toLowerCase();
    setIsCommandMode(false);
    setCommandInput('');

    if (cmd === '/close' || cmd === '/quit' || cmd === '/exit' || cmd === 'close' || cmd === 'quit' || cmd === 'exit') {
      handleQuit();
      return;
    }

    if (
      cmd === '/browse-issues' ||
      cmd === 'browse-issues' ||
      cmd === '/browse' ||
      cmd === 'browse' ||
      cmd === '/issues' ||
      cmd === 'issues' ||
      cmd === '/tree' ||
      cmd === 'tree'
    ) {
      setBrowserIndex(0);
      setBrowserConfirmAction(null);
      setBrowserStatusMessage(undefined);
      setView('issue_browser');
      return;
    }

    if (
      cmd === '/specs' ||
      cmd === 'specs' ||
      cmd === '/start' ||
      cmd === 'start' ||
      cmd === '/scope' ||
      cmd === 'scope'
    ) {
      setHighlightedSpecIndex(0);
      const currentSpecs = dag ? dag.getTargetSpecs() : [];
      if (currentSpecs.length > 0) {
        setSelectedSpecNumbers(new Set(currentSpecs));
        setIsAllTasksSelected(false);
      } else {
        setSelectedSpecNumbers(new Set());
        setIsAllTasksSelected(true);
      }
      setView('spec_picker');
      return;
    }

    if (cmd === '/logs' || cmd === 'logs' || cmd === '/activity' || cmd === 'activity' || cmd === '/log' || cmd === 'log') {
      setLogScrollOffset(Math.max(0, activityLogs.length - 16));
      setView('logs');
      return;
    }

    if (cmd === '/usage' || cmd === 'usage') {
      setIsRefreshingUsage(true);
      orchestrator.getQuotaMonitor().fetchLiveUsage(true).finally(() => {
        setIsRefreshingUsage(false);
      });
      setView('usage');
      return;
    }

    if (cmd === '/resume' || cmd === 'resume') {
      orchestrator.resumeQuota();
      orchestrator.tick().catch(() => {});
      setCommandResult({
        type: 'success',
        title: '🔄 Quota Pause Cleared',
        lines: ['Cleared quota pause state. Workers resuming...'],
      });
      return;
    }

    if (
      cmd.startsWith('/enqueue') ||
      cmd.startsWith('enqueue') ||
      cmd.startsWith('/run') ||
      cmd.startsWith('run') ||
      cmd.startsWith('/dispatch') ||
      cmd.startsWith('dispatch') ||
      cmd.startsWith('/force-run') ||
      cmd.startsWith('force-run')
    ) {
      const parts = rawCmd.trim().split(/\s+/);
      const parsedArgs = parseEnqueueArgs(parts.slice(1));
      const force =
        parsedArgs.force || parts[0] === '/force-run' || parts[0] === 'force-run';
      const { now, runner, unknownFlags } = parsedArgs;

      if (unknownFlags.length > 0) {
        setCommandResult({
          type: 'error',
          title: '⚠️ Unknown Option',
          lines: [
            `Not recognised: ${unknownFlags.join(', ')}`,
            `Usage: ${ENQUEUE_USAGE}`,
            ...formatEnqueueFlagLines('  ', false),
          ],
        });
        return;
      }

      if (parsedArgs.issueNumber === undefined) {
        setCommandResult({
          type: 'error',
          title: '⚠️ Missing Issue Number',
          lines: [
            `Usage: ${ENQUEUE_USAGE}`,
            ENQUEUE_SUMMARY,
            ...formatEnqueueFlagLines('  ', false),
            '',
            'Examples:',
            ...ENQUEUE_EXAMPLES.map((e) => `  ${e}`),
          ],
        });
        return;
      }

      const issueNum = parsedArgs.issueNumber;

      try {
        const res = await orchestrator.enqueueTask(issueNum, { force, now, runner });
        if (res.requiresConfirmation && !force) {
          setCommandResult({
            type: 'info',
            title: '⚠️ Confirmation Required',
            lines: [
              res.message,
              `Pass --force to bypass confirmation: /enqueue ${issueNum} --force`,
            ],
          });
        } else if (res.success) {
          setCommandResult({
            type: 'success',
            title: '⚡ Priority Enqueued',
            lines: [res.message],
          });
        } else {
          setCommandResult({
            type: 'error',
            title: '❌ Enqueue Failed',
            lines: [res.message],
          });
        }
      } catch (err: any) {
        setCommandResult({
          type: 'error',
          title: '❌ Enqueue Error',
          lines: [err?.message || 'Unknown error occurred while enqueuing task.'],
        });
      }
      return;
    }

    if (cmd === '/status' || cmd === 'status') {
      const readyCount = dag ? dag.getReadyNodes().length : 0;
      const waitingCount = dag ? dag.getWaitingFeedbackNodes().length : 0;
      const blockedCount = dag ? dag.getBlockedNodes().length : 0;
      const triageCount = dag ? dag.getTriageNodes().length : 0;
      setCommandResult({
        type: 'info',
        title: '📋 Issue DAG Status Overview',
        lines: [
          `Ready: ${readyCount} tasks | Waiting: ${waitingCount} tasks | Blocked: ${blockedCount} tasks | Triage: ${triageCount} tasks`,
          `Active workers: ${activeWorkersMap.size} | Worktrees on disk: ${orchestrator.getActiveWorktrees().length}`,
        ],
      });
      return;
    }

    if (cmd === '/clean' || cmd === 'clean') {
      try {
        await orchestrator.getWorktreeManager().pruneWorktrees();
        setCommandResult({
          type: 'success',
          title: '🧹 Worktree Cleanup Complete',
          lines: ['Pruned inactive git worktree allocations and cleaned session data.'],
        });
      } catch (err: any) {
        setCommandResult({
          type: 'error',
          title: '❌ Cleanup Failed',
          lines: [err.message || 'Unknown error during cleanup'],
        });
      }
      return;
    }

    if (
      cmd === '/install-skills' ||
      cmd === 'install-skills' ||
      cmd === '/skills' ||
      cmd === 'skills' ||
      cmd === '/skills-install'
    ) {
      setCommandResult({
        type: 'info',
        title: '📦 Installing Imagos Skills...',
        lines: ['Running `npx skills add arleypadua/imagos` in background...'],
      });

      import('execa').then(({ execa }) => {
        execa('npx', ['skills', 'add', 'arleypadua/imagos'])
          .then(() => {
            setCommandResult({
              type: 'success',
              title: '✓ Imagos Skills Installed',
              lines: [
                'Successfully installed Imagos AI skills into your agent environment!',
                'Available skills: imagos-summary, imagos-spec-writer',
              ],
            });
          })
          .catch((err: any) => {
            setCommandResult({
              type: 'error',
              title: '❌ Skill Installation Failed',
              lines: [
                err.message || 'Failed to install skills via npx skills add',
                'You can run manually: npx skills add arleypadua/imagos',
              ],
            });
          });
      });
      return;
    }

    if (
      cmd === '/providers' ||
      cmd === 'providers' ||
      cmd === '/runners' ||
      cmd === 'runners' ||
      cmd === '/allowed-providers' ||
      cmd === 'allowed-providers'
    ) {
      const detected = await orchestrator.getDetectedProviders();
      setProvidersList(detected);
      setHighlightedProviderIndex(0);
      setProvidersStatusMessage(undefined);
      setView('providers');
      return;
    }

    if (cmd === '/help' || cmd === 'help') {
      setCommandResult({
        type: 'info',
        title: 'ℹ️ Available Commands & Keyboard Shortcuts',
        lines: [
          '/browse-issues  - Interactive tree browser for open specs, child tasks, and standalone issues',
          '/specs          - Change target specs scope or select Any unblocked task',
          '/providers      - Toggle allowed LLM providers/runners for this repository',
          '/logs           - Open dedicated system and daemon activity logs window',
          '/usage          - Open live quota telemetry window with scheduled wake-up timer',
          '/install-skills - Install Imagos AI skills into your agent environment via skills.sh',
          '/close          - Gracefully shutdown orchestrator daemon and quit',
          '/resume         - Clear quota pause and resume workers immediately',
          '/status         - Refresh and display DAG queue summary',
          '/clean          - Prune stale worktrees and temporary session branches',
          '↑/↓ or j/k - Move selection | Enter - Inspect task / View category | q - Quit',
        ],
      });
      return;
    }

    setCommandResult({
      type: 'error',
      title: '❌ Unknown Command',
      lines: [`Command "${rawCmd}" not recognized. Type /help to see available commands.`],
    });
  };

  // Keyboard navigation & input handling
  useInput((input, key) => {
    if (view === 'dashboard') {
      const query = commandInput.trim().toLowerCase();
      const filteredCommands = AVAILABLE_COMMANDS.filter((cmd) => {
        if (!query || query === '/') return true;
        if (cmd.name.toLowerCase().startsWith(query)) return true;
        if (cmd.name.toLowerCase().includes(query)) return true;
        if (cmd.aliases?.some((a) => a.toLowerCase().startsWith(query) || a.toLowerCase().includes(query))) return true;
        return false;
      });

      if (isCommandMode) {
        if (key.escape) {
          setIsCommandMode(false);
          setCommandInput('');
          setSelectedCommandIndex(0);
          return;
        }

        if (key.upArrow) {
          setSelectedCommandIndex((prev) => Math.max(0, prev - 1));
          return;
        }

        if (key.downArrow) {
          setSelectedCommandIndex((prev) => Math.min(Math.max(0, filteredCommands.length - 1), prev + 1));
          return;
        }

        if (key.tab) {
          if (filteredCommands.length > 0 && filteredCommands[selectedCommandIndex]) {
            setCommandInput(filteredCommands[selectedCommandIndex].name);
          }
          return;
        }

        if (key.return) {
          if (filteredCommands.length > 0 && selectedCommandIndex < filteredCommands.length && (!commandInput.trim() || commandInput === '/')) {
            handleExecuteCommand(filteredCommands[selectedCommandIndex].name);
          } else if (commandInput.trim()) {
            const matchingCmd = filteredCommands[selectedCommandIndex]?.name || commandInput.trim();
            handleExecuteCommand(matchingCmd);
          } else {
            setIsCommandMode(false);
          }
          return;
        }

        if (key.backspace || key.delete) {
          setCommandInput((prev) => {
            const next = prev.slice(0, -1);
            if (!next) {
              setIsCommandMode(false);
            }
            setSelectedCommandIndex(0);
            return next;
          });
          return;
        }

        if (input && !key.ctrl && !key.meta) {
          setCommandInput((prev) => {
            setSelectedCommandIndex(0);
            return prev + input;
          });
          return;
        }
      }

      // Quick trigger for command mode via '/' or ':'
      if (input === '/' || input === ':') {
        setIsCommandMode(true);
        setCommandInput(input === '/' ? '/' : '/');
        setSelectedCommandIndex(0);
        return;
      }

      if (input === 'q' || (key.ctrl && input === 'c')) {
        handleQuit();
        return;
      }

      const totalDashboardItems = workers.length + 6;

      if (key.upArrow || input === 'k') {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
        return;
      }

      if (key.downArrow || input === 'j') {
        setSelectedIndex((prev) => Math.min(totalDashboardItems - 1, prev + 1));
        return;
      }

      if (key.return) {
        if (selectedIndex < workers.length && workers[selectedIndex]) {
          const selectedWorker = workers[selectedIndex];
          setInspectIssueNumber(selectedWorker.issueNumber);
          loadHistoricalEvents(selectedWorker.issueNumber);
          setView('inspect');
          setInputText('');
          setStatusMessage(undefined);
          setCommandResult(null);
        } else if (selectedIndex === workers.length) {
          setHighlightedSpecIndex(0);
          const currentSpecs = dag ? dag.getTargetSpecs() : [];
          if (currentSpecs.length > 0) {
            setSelectedSpecNumbers(new Set(currentSpecs));
            setIsAllTasksSelected(false);
          } else {
            setSelectedSpecNumbers(new Set());
            setIsAllTasksSelected(true);
          }
          setConfirmAction(null);
          setCategoryStatusMessage(undefined);
          setView('spec_picker');
        } else if (selectedIndex === workers.length + 1) {
          setSelectedCategory('ready');
          setCategoryItemIndex(0);
          setConfirmAction(null);
          setCategoryStatusMessage(undefined);
          setView('category_issues');
        } else if (selectedIndex === workers.length + 2) {
          setSelectedCategory('waiting');
          setCategoryItemIndex(0);
          setConfirmAction(null);
          setCategoryStatusMessage(undefined);
          setView('category_issues');
        } else if (selectedIndex === workers.length + 3) {
          setSelectedCategory('blocked');
          setCategoryItemIndex(0);
          setConfirmAction(null);
          setCategoryStatusMessage(undefined);
          setView('category_issues');
        } else if (selectedIndex === workers.length + 4) {
          setSelectedCategory('triage');
          setCategoryItemIndex(0);
          setConfirmAction(null);
          setCategoryStatusMessage(undefined);
          setView('category_issues');
        } else if (selectedIndex === workers.length + 5) {
          setLogScrollOffset(Math.max(0, activityLogs.length - 16));
          setView('logs');
        }
        return;
      }
    } else if (view === 'category_issues') {
      const issues = buildCategoryIssues(selectedCategory);
      const currentItem = issues[categoryItemIndex];

      if (confirmAction && confirmAction.type === 'kill') {
        if (input === 'y' || input === 'Y') {
          const issueNum = confirmAction.issueNumber;
          setConfirmAction(null);
          setCategoryStatusMessage(`⏳ Killing worker and wiping worktree for #${issueNum}...`);
          orchestrator.killAndWipeWorker(issueNum).then((res) => {
            setCategoryStatusMessage(`✓ ${res.message}`);
            setTimeout(() => setCategoryStatusMessage(undefined), 5000);
          });
          return;
        }

        if (input === 'n' || input === 'N' || key.escape) {
          setConfirmAction(null);
          setCategoryStatusMessage('Kill action cancelled.');
          setTimeout(() => setCategoryStatusMessage(undefined), 2000);
          return;
        }
        return;
      }

      if (confirmAction && confirmAction.type === 'enqueue') {
        if (input === 'y' || input === 'Y') {
          const issueNum = confirmAction.issueNumber;
          setConfirmAction(null);
          setCategoryStatusMessage(`⏳ Enqueuing Issue #${issueNum}...`);
          orchestrator.enqueueTask(issueNum, { force: true }).then((res) => {
            setCategoryStatusMessage(res.success ? `✓ ${res.message}` : `❌ ${res.message}`);
            setTimeout(() => setCategoryStatusMessage(undefined), 5000);
          });
          return;
        }

        if (input === 'n' || input === 'N' || key.escape) {
          setConfirmAction(null);
          setCategoryStatusMessage('Enqueue action cancelled.');
          setTimeout(() => setCategoryStatusMessage(undefined), 2000);
          return;
        }
        return;
      }

      if (key.escape) {
        setView('dashboard');
        setCategoryStatusMessage(undefined);
        setConfirmAction(null);
        return;
      }

      if (key.upArrow || input === 'k') {
        setCategoryItemIndex((prev) => Math.max(0, prev - 1));
        return;
      }

      if (key.downArrow || input === 'j') {
        setCategoryItemIndex((prev) => Math.min(Math.max(0, issues.length - 1), prev + 1));
        return;
      }

      if (input === 'e') {
        if (currentItem) {
          orchestrator.enqueueTask(currentItem.issue.number, { force: false }).then((res) => {
            if (res.requiresConfirmation) {
              setConfirmAction({
                type: 'enqueue',
                issueNumber: currentItem.issue.number,
                message: res.message,
              });
            } else {
              setCategoryStatusMessage(res.success ? `✓ ${res.message}` : `❌ ${res.message}`);
              setTimeout(() => setCategoryStatusMessage(undefined), 5000);
            }
          }).catch((err) => {
            setCategoryStatusMessage(`❌ ${err?.message || 'Failed to enqueue task'}`);
            setTimeout(() => setCategoryStatusMessage(undefined), 5000);
          });
        }
        return;
      }

      if (input === 'o') {
        if (currentItem) {
          orchestrator.openIssueInBrowser(currentItem.issue.number).then((res) => {
            setCategoryStatusMessage(res.message);
            setTimeout(() => setCategoryStatusMessage(undefined), 4000);
          });
        }
        return;
      }

      if (input === 'p') {
        if (currentItem && currentItem.worker) {
          if (currentItem.worker.status === 'paused_quota') {
            orchestrator.resumeWorker(currentItem.issue.number).then((res) => {
              setCategoryStatusMessage(`✓ ${res.message}`);
              setTimeout(() => setCategoryStatusMessage(undefined), 4000);
            });
          } else {
            orchestrator.pauseWorker(currentItem.issue.number).then((res) => {
              setCategoryStatusMessage(`⏸️ ${res.message}`);
              setTimeout(() => setCategoryStatusMessage(undefined), 4000);
            });
          }
        } else {
          setCategoryStatusMessage(`ℹ️ Issue #${currentItem?.issue.number} has no active worker to pause/resume.`);
          setTimeout(() => setCategoryStatusMessage(undefined), 3000);
        }
        return;
      }

      if (input === 'k') {
        if (currentItem) {
          setConfirmAction({ type: 'kill', issueNumber: currentItem.issue.number });
        }
        return;
      }

      if (key.return) {
        if (currentItem?.worker) {
          setInspectIssueNumber(currentItem.issue.number);
          loadHistoricalEvents(currentItem.issue.number);
          setView('inspect');
          setInputText('');
          setStatusMessage(undefined);
        }
        return;
      }

      if (input === 'q' || (key.ctrl && input === 'c')) {
        handleQuit();
        return;
      }
    } else if (view === 'inspect') {
      // Per user instruction: ONLY Escape exits back to master dashboard, NOT backspace when input is empty!
      if (key.escape) {
        setView('dashboard');
        setStatusMessage(undefined);
        return;
      }

      if (key.return) {
        if (inputText.trim() && inspectIssueNumber !== null && !isSubmitting) {
          const promptToSend = inputText.trim();
          setIsSubmitting(true);
          setStatusMessage(`⏳ Injected prompt: waiting for safe pause & resume...`);

          orchestrator.injectPrompt(inspectIssueNumber, promptToSend).then((res) => {
            setIsSubmitting(false);
            setInputText('');
            setStatusMessage(res.message);
            setTimeout(() => {
              setStatusMessage((current) => (current === res.message ? undefined : current));
            }, 5000);
          }).catch((err) => {
            setIsSubmitting(false);
            setStatusMessage(`❌ Error injecting prompt: ${err.message}`);
          });
        }
        return;
      }

      if (key.backspace || key.delete) {
        setInputText((prev) => prev.slice(0, -1));
        return;
      }

      // Handle normal typed characters
      if (input && !key.ctrl && !key.meta) {
        setInputText((prev) => prev + input);
      }
    } else if (view === 'usage') {
      if (key.escape) {
        setView('dashboard');
        return;
      }

      if (input === 'r') {
        setIsRefreshingUsage(true);
        orchestrator.getQuotaMonitor().fetchLiveUsage(true).finally(() => {
          setIsRefreshingUsage(false);
        });
        return;
      }

      if (input === 'q' || (key.ctrl && input === 'c')) {
        handleQuit();
        return;
      }
    } else if (view === 'logs') {
      if (key.escape) {
        setView('dashboard');
        return;
      }

      if (key.upArrow || input === 'k') {
        setLogScrollOffset((prev) => Math.max(0, prev - 1));
        return;
      }

      if (key.downArrow || input === 'j') {
        const maxScroll = Math.max(0, activityLogs.length - 16);
        setLogScrollOffset((prev) => Math.min(maxScroll, prev + 1));
        return;
      }

      if (input === 'c') {
        orchestrator.getDashboard().clearLogs();
        setLogScrollOffset(0);
        return;
      }

      if (input === 'q' || (key.ctrl && input === 'c')) {
        handleQuit();
        return;
      }
    } else if (view === 'spec_picker') {
      const currentOpt = specOptions[highlightedSpecIndex];

      if (confirmAction && confirmAction.type === 'kill') {
        if (input === 'y' || input === 'Y') {
          const issueNum = confirmAction.issueNumber;
          setConfirmAction(null);
          setCategoryStatusMessage(`⏳ Killing worker and wiping worktree for #${issueNum}...`);
          orchestrator.killAndWipeWorker(issueNum).then((res) => {
            setCategoryStatusMessage(`✓ ${res.message}`);
            setTimeout(() => setCategoryStatusMessage(undefined), 5000);
          });
          return;
        }

        if (input === 'n' || input === 'N' || key.escape) {
          setConfirmAction(null);
          setCategoryStatusMessage('Kill action cancelled.');
          setTimeout(() => setCategoryStatusMessage(undefined), 2000);
          return;
        }
        return;
      }

      if (key.escape) {
        setView('dashboard');
        setCategoryStatusMessage(undefined);
        setConfirmAction(null);
        return;
      }

      if (key.upArrow || input === 'k') {
        setHighlightedSpecIndex((prev) => Math.max(0, prev - 1));
        return;
      }

      if (key.downArrow || input === 'j') {
        setHighlightedSpecIndex((prev) => Math.min(Math.max(0, specOptions.length - 1), prev + 1));
        return;
      }

      if (input === ' ') {
        const opt = specOptions[highlightedSpecIndex];
        if (opt) {
          if (opt.isAllTasks) {
            setIsAllTasksSelected((prev) => {
              const next = !prev;
              if (next) setSelectedSpecNumbers(new Set());
              return next;
            });
          } else if (opt.number !== undefined) {
            setIsAllTasksSelected(false);
            setSelectedSpecNumbers((prev) => {
              const next = new Set(prev);
              if (next.has(opt.number!)) {
                next.delete(opt.number!);
              } else {
                next.add(opt.number!);
              }
              return next;
            });
          }
        }
        return;
      }

      if (input === 'a') {
        setIsAllTasksSelected((prev) => {
          const next = !prev;
          if (next) setSelectedSpecNumbers(new Set());
          return next;
        });
        return;
      }

      if (input === 'o') {
        if (currentOpt && currentOpt.number !== undefined) {
          orchestrator.openIssueInBrowser(currentOpt.number).then((res) => {
            setCategoryStatusMessage(res.message);
            setTimeout(() => setCategoryStatusMessage(undefined), 4000);
          });
        }
        return;
      }

      if (input === 'p') {
        if (currentOpt && currentOpt.worker) {
          if (currentOpt.worker.status === 'paused_quota') {
            orchestrator.resumeWorker(currentOpt.worker.issueNumber).then((res) => {
              setCategoryStatusMessage(`✓ ${res.message}`);
              setTimeout(() => setCategoryStatusMessage(undefined), 4000);
            });
          } else {
            orchestrator.pauseWorker(currentOpt.worker.issueNumber).then((res) => {
              setCategoryStatusMessage(`⏸️ ${res.message}`);
              setTimeout(() => setCategoryStatusMessage(undefined), 4000);
            });
          }
        } else if (currentOpt && currentOpt.number !== undefined) {
          setCategoryStatusMessage(`ℹ️ Spec #${currentOpt.number} has no active worker to pause/resume.`);
          setTimeout(() => setCategoryStatusMessage(undefined), 3000);
        }
        return;
      }

      if (input === 'x' || (input === 'k' && !key.upArrow && currentOpt?.worker)) {
        if (currentOpt && currentOpt.number !== undefined) {
          setConfirmAction({ type: 'kill', issueNumber: currentOpt.number });
        }
        return;
      }

      if (input === 'i') {
        if (currentOpt && currentOpt.number !== undefined) {
          setInspectIssueNumber(currentOpt.number);
          loadHistoricalEvents(currentOpt.number);
          setView('inspect');
          setInputText('');
          setStatusMessage(undefined);
        }
        return;
      }

      if (key.return) {
        if (isAllTasksSelected || (selectedSpecNumbers.size === 0 && specOptions[highlightedSpecIndex]?.isAllTasks)) {
          orchestrator.setTargetSpecs([]);
          setCommandResult({
            type: 'success',
            title: '🎯 Target Scope Updated',
            lines: ['Processing any unblocked task across all specs.'],
          });
        } else if (selectedSpecNumbers.size > 0) {
          const specsArr = Array.from(selectedSpecNumbers);
          orchestrator.setTargetSpecs(specsArr);
          setCommandResult({
            type: 'success',
            title: '🎯 Target Scope Updated',
            lines: [`Scoped execution to ${specsArr.length} spec(s): ${specsArr.map((s) => `#${s}`).join(', ')}`],
          });
        } else {
          // If user didn't check anything with space, use currently highlighted item
          const opt = specOptions[highlightedSpecIndex];
          if (opt?.isAllTasks) {
            orchestrator.setTargetSpecs([]);
            setCommandResult({
              type: 'success',
              title: '🎯 Target Scope Updated',
              lines: ['Processing any unblocked task across all specs.'],
            });
          } else if (opt?.number !== undefined) {
            orchestrator.setTargetSpecs([opt.number]);
            setCommandResult({
              type: 'success',
              title: '🎯 Target Scope Updated',
              lines: [`Scoped execution to Spec #${opt.number}: ${opt.title}`],
            });
          }
        }
        setView('dashboard');
        return;
      }

      if (input === 'q' || (key.ctrl && input === 'c')) {
        handleQuit();
        return;
      }
    } else if (view === 'providers') {
      if (key.escape) {
        setView('dashboard');
        setProvidersStatusMessage(undefined);
        return;
      }

      if (key.upArrow || input === 'k') {
        setHighlightedProviderIndex((prev) => Math.max(0, prev - 1));
        return;
      }

      if (key.downArrow || input === 'j') {
        setHighlightedProviderIndex((prev) => Math.min(Math.max(0, providersList.length - 1), prev + 1));
        return;
      }

      if (input === ' ') {
        const current = providersList[highlightedProviderIndex];
        if (current) {
          setProvidersList((prev) =>
            prev.map((p, idx) => (idx === highlightedProviderIndex ? { ...p, isAllowed: !p.isAllowed } : p))
          );
        }
        return;
      }

      if (input === 'd') {
        const current = providersList[highlightedProviderIndex];
        if (current) {
          setProvidersList((prev) =>
            prev.map((p, idx) =>
              idx === highlightedProviderIndex
                ? { ...p, isDefault: true, isAllowed: true }
                : { ...p, isDefault: false }
            )
          );
          setProvidersStatusMessage(`✓ Set default runner to ${current.displayName}`);
          setTimeout(() => setProvidersStatusMessage(undefined), 3000);
        }
        return;
      }

      if (input === 'a') {
        setProvidersList((prev) =>
          prev.map((p) => ({ ...p, isAllowed: p.isInstalled }))
        );
        setProvidersStatusMessage('✓ Allowed all installed providers');
        setTimeout(() => setProvidersStatusMessage(undefined), 3000);
        return;
      }

      if (key.return) {
        const allowedIds = providersList.filter((p) => p.isAllowed).map((p) => p.id);
        const defaultRunner = providersList.find((p) => p.isDefault)?.id || config.runner;

        orchestrator.setAllowedProviders(allowedIds, defaultRunner).then((res) => {
          setCommandResult({
            type: 'success',
            title: '🔌 Allowed Providers Configured',
            lines: [
              `Saved allowed providers to .autopilot/config.json: ${allowedIds.length > 0 ? allowedIds.join(', ') : 'none'}`,
              `Default runner: ${defaultRunner}`,
            ],
          });
        });

        setView('dashboard');
        return;
      }

      if (input === 'q' || (key.ctrl && input === 'c')) {
        handleQuit();
        return;
      }
    } else if (view === 'issue_browser') {
      const { items } = buildTreeItems(expandedSpecs, showOnlyOpen);
      const currentItem = items[browserIndex];

      if (browserConfirmAction && browserConfirmAction.type === 'kill') {
        if (input === 'y' || input === 'Y') {
          const issueNum = browserConfirmAction.issueNumber;
          setBrowserConfirmAction(null);
          setBrowserStatusMessage(`⏳ Killing worker and wiping worktree for #${issueNum}...`);
          orchestrator.killAndWipeWorker(issueNum).then((res) => {
            setBrowserStatusMessage(`✓ ${res.message}`);
            setTimeout(() => setBrowserStatusMessage(undefined), 5000);
          });
          return;
        }

        if (input === 'n' || input === 'N' || key.escape) {
          setBrowserConfirmAction(null);
          setBrowserStatusMessage('Kill action cancelled.');
          setTimeout(() => setBrowserStatusMessage(undefined), 2000);
          return;
        }
        return;
      }

      if (browserConfirmAction && browserConfirmAction.type === 'enqueue') {
        if (input === 'y' || input === 'Y') {
          const issueNum = browserConfirmAction.issueNumber;
          setBrowserConfirmAction(null);
          setBrowserStatusMessage(`⏳ Enqueuing Issue #${issueNum}...`);
          orchestrator.enqueueTask(issueNum, { force: true }).then((res) => {
            setBrowserStatusMessage(res.success ? `✓ ${res.message}` : `❌ ${res.message}`);
            setTimeout(() => setBrowserStatusMessage(undefined), 5000);
          });
          return;
        }

        if (input === 'n' || input === 'N' || key.escape) {
          setBrowserConfirmAction(null);
          setBrowserStatusMessage('Enqueue action cancelled.');
          setTimeout(() => setBrowserStatusMessage(undefined), 2000);
          return;
        }
        return;
      }

      if (key.escape) {
        setView('dashboard');
        setBrowserStatusMessage(undefined);
        setBrowserConfirmAction(null);
        return;
      }

      if (key.upArrow || input === 'k') {
        setBrowserIndex((prev) => Math.max(0, prev - 1));
        return;
      }

      if (key.downArrow || input === 'j') {
        setBrowserIndex((prev) => Math.min(Math.max(0, items.length - 1), prev + 1));
        return;
      }

      // Expand / Collapse current spec & Left arrow on child to collapse parent and move cursor
      if (input === ' ' || key.rightArrow || key.leftArrow || input === 'h' || input === 'l') {
        const isLeft = key.leftArrow || input === 'h';
        const isRight = key.rightArrow || input === 'l';

        if (currentItem && currentItem.type === 'child' && isLeft) {
          const parentSpecNum = currentItem.parentSpecNumber;
          const parentIndex = items.findIndex((it) => it.type === 'spec' && it.number === parentSpecNum);
          setExpandedSpecs((prev) => {
            const next = new Set(prev);
            next.delete(parentSpecNum);
            return next;
          });
          if (parentIndex !== -1) {
            setBrowserIndex(parentIndex);
          }
          return;
        }

        if (currentItem && currentItem.type === 'spec') {
          setExpandedSpecs((prev) => {
            const next = new Set(prev);
            if (isLeft) {
              next.delete(currentItem.number);
            } else if (isRight) {
              next.add(currentItem.number);
            } else if (next.has(currentItem.number)) {
              next.delete(currentItem.number);
            } else {
              next.add(currentItem.number);
            }
            return next;
          });
        }
        return;
      }

      // Expand all / collapse all specs toggle
      if (input === 'a') {
        if (dag) {
          const openSpecs = dag.getAllNodes().filter((n) => n.kind === 'spec' && n.issue.state === 'OPEN');
          if (expandedSpecs.size >= openSpecs.length && openSpecs.length > 0) {
            setExpandedSpecs(new Set());
            setBrowserStatusMessage('Collapsed all specifications.');
          } else {
            setExpandedSpecs(new Set(openSpecs.map((s) => s.issue.number)));
            setBrowserStatusMessage(`Expanded all ${openSpecs.length} specifications.`);
          }
          setTimeout(() => setBrowserStatusMessage(undefined), 2500);
        }
        return;
      }

      // Toggle show only open vs show all child tasks
      if (input === 'c' || input === 'C') {
        setShowOnlyOpen((prev) => {
          const next = !prev;
          setBrowserStatusMessage(next ? 'Filter: Showing only open child tasks.' : 'Filter: Showing all child tasks (including completed).');
          setTimeout(() => setBrowserStatusMessage(undefined), 3000);
          return next;
        });
        return;
      }

      // Enqueue
      if (input === 'e') {
        if (currentItem) {
          orchestrator.enqueueTask(currentItem.number, { force: false }).then((res) => {
            if (res.requiresConfirmation) {
              setBrowserConfirmAction({
                type: 'enqueue',
                issueNumber: currentItem.number,
                message: res.message,
              });
            } else {
              setBrowserStatusMessage(res.success ? `✓ ${res.message}` : `❌ ${res.message}`);
              setTimeout(() => setBrowserStatusMessage(undefined), 5000);
            }
          }).catch((err) => {
            setBrowserStatusMessage(`❌ ${err?.message || 'Failed to enqueue task'}`);
            setTimeout(() => setBrowserStatusMessage(undefined), 5000);
          });
        }
        return;
      }

      // Open in browser
      if (input === 'o') {
        if (currentItem) {
          orchestrator.openIssueInBrowser(currentItem.number).then((res) => {
            setBrowserStatusMessage(res.message);
            setTimeout(() => setBrowserStatusMessage(undefined), 4000);
          });
        }
        return;
      }

      // Pause / Resume
      if (input === 'p') {
        if (currentItem && currentItem.worker) {
          if (currentItem.worker.status === 'paused_quota') {
            orchestrator.resumeWorker(currentItem.number).then((res) => {
              setBrowserStatusMessage(`✓ ${res.message}`);
              setTimeout(() => setBrowserStatusMessage(undefined), 4000);
            });
          } else {
            orchestrator.pauseWorker(currentItem.number).then((res) => {
              setBrowserStatusMessage(`⏸️ ${res.message}`);
              setTimeout(() => setBrowserStatusMessage(undefined), 4000);
            });
          }
        } else {
          setBrowserStatusMessage(`ℹ️ Issue #${currentItem?.number} has no active worker to pause/resume.`);
          setTimeout(() => setBrowserStatusMessage(undefined), 3000);
        }
        return;
      }

      // Kill worker & wipe worktree
      if (input === 'k' && !key.upArrow) {
        if (currentItem) {
          setBrowserConfirmAction({ type: 'kill', issueNumber: currentItem.number });
        }
        return;
      }

      // Inspect / Live tail
      if (key.return || input === 'i') {
        if (currentItem) {
          setInspectIssueNumber(currentItem.number);
          loadHistoricalEvents(currentItem.number);
          setView('inspect');
          setInputText('');
          setStatusMessage(undefined);
        }
        return;
      }

      if (input === 'q' || (key.ctrl && input === 'c')) {
        handleQuit();
        return;
      }
    }
  });

  if (view === 'issue_browser') {
    const { items, totalSpecsCount, totalStandaloneCount } = buildTreeItems(expandedSpecs, showOnlyOpen);
    return (
      <IssueBrowserView
        items={items}
        selectedIndex={browserIndex}
        confirmAction={browserConfirmAction}
        statusMessage={browserStatusMessage}
        repository={config.repository}
        totalSpecsCount={totalSpecsCount}
        totalStandaloneCount={totalStandaloneCount}
        showOnlyOpen={showOnlyOpen}
      />
    );
  }

  if (view === 'providers') {
    return (
      <ProvidersPickerView
        providers={providersList}
        highlightedIndex={highlightedProviderIndex}
        statusMessage={providersStatusMessage}
        repository={config.repository}
      />
    );
  }

  if (view === 'category_issues') {
    const issues = buildCategoryIssues(selectedCategory);
    return (
      <CategoryIssuesView
        categoryTitle={getCategoryTitle(selectedCategory)}
        issues={issues}
        selectedIndex={categoryItemIndex}
        confirmAction={confirmAction}
        statusMessage={categoryStatusMessage}
        repository={config.repository}
      />
    );
  }

  if (view === 'spec_picker') {
    return (
      <SpecPickerView
        options={specOptions}
        highlightedIndex={highlightedSpecIndex}
        selectedNumbers={selectedSpecNumbers}
        isAllTasksSelected={isAllTasksSelected}
        confirmAction={confirmAction}
        statusMessage={categoryStatusMessage}
        repository={config.repository}
      />
    );
  }

  if (view === 'logs') {
    return (
      <ActivityLogView
        logs={activityLogs}
        repository={config.repository}
        scrollOffset={logScrollOffset}
      />
    );
  }

  if (view === 'usage') {
    return (
      <UsageView
        quotaStatus={quotaStatus}
        repository={config.repository}
        allowedProviders={config.allowedProviders || config.allowedRunners}
        isRefreshing={isRefreshingUsage}
      />
    );
  }

  if (view === 'inspect' && inspectIssueNumber !== null) {
    const currentWorker = workers.find((w) => w.issueNumber === inspectIssueNumber) || {
      issueNumber: inspectIssueNumber,
      title: `Issue #${inspectIssueNumber}`,
      branchName: `issue-${inspectIssueNumber}`,
      status: 'running' as const,
    };
    let events = eventsMap.get(inspectIssueNumber) || eventBus.getHistory(inspectIssueNumber);
    if (events.length === 0) {
      events = loadHistoricalEvents(inspectIssueNumber);
    }

    return (
      <InspectView
        worker={currentWorker}
        events={events}
        inputText={inputText}
        isSubmitting={isSubmitting}
        statusMessage={statusMessage}
      />
    );
  }

  return (
    <MasterDashboard
      config={config}
      dag={dag}
      quotaStatus={quotaStatus}
      workers={workers}
      selectedIndex={selectedIndex}
      activityLogs={activityLogs}
      commandInput={commandInput}
      isCommandMode={isCommandMode}
      commandResult={commandResult}
      selectedCommandIndex={selectedCommandIndex}
      isSessionStarted={isSessionStarted}
    />
  );
};
