import React from 'react';
import { Box, Text } from 'ink';

export interface CommandDefinition {
  name: string;
  description: string;
  aliases?: string[];
}

export const AVAILABLE_COMMANDS: CommandDefinition[] = [
  {
    name: '/browse-issues',
    description: 'Interactive tree browser for open specs, child tasks, and standalone issues',
    aliases: ['browse-issues', '/browse', 'browse', '/issues', 'issues', '/tree', 'tree'],
  },
  {
    name: '/specs',
    description: 'Select target specs to scope execution or choose Any unblocked task',
    aliases: ['specs', '/start', 'start', '/scope', 'scope'],
  },
  {
    name: '/enqueue',
    description: 'Queue an issue first (/enqueue <num> [--now] [--runner <name>] [--force])',
    aliases: ['enqueue', '/run', 'run', '/dispatch', 'dispatch', '/force-run'],
  },
  {
    name: '/logs',
    description: 'View chronological system and daemon activity logs',
    aliases: ['logs', '/activity', 'activity', '/log', 'log'],
  },
  {
    name: '/usage',
    description: 'Show 5h & weekly quota telemetry with scheduled wake-up time',
    aliases: ['usage'],
  },
  {
    name: '/close',
    description: 'Gracefully shutdown orchestrator daemon and quit',
    aliases: ['close', '/quit', 'quit', '/exit', 'exit'],
  },
  {
    name: '/resume',
    description: 'Clear quota pause and resume workers immediately',
    aliases: ['resume'],
  },
  {
    name: '/status',
    description: 'Refresh and display DAG queue summary',
    aliases: ['status'],
  },
  {
    name: '/clean',
    description: 'Prune stale worktrees and temporary session branches',
    aliases: ['clean'],
  },
  {
    name: '/install-skills',
    description: 'Install Imagos AI skills into your AI agent environment via skills.sh',
    aliases: ['install-skills', '/skills', 'skills', '/skills-install'],
  },
  {
    name: '/providers',
    description: 'Toggle allowed LLM providers/runners for this repository (.autopilot/config.json)',
    aliases: ['providers', '/runners', 'runners', '/allowed-providers', 'allowed-providers'],
  },
  {
    name: '/help',
    description: 'List all available slash commands and keyboard shortcuts',
    aliases: ['help'],
  },
];

export interface CommandResult {
  type: 'usage' | 'info' | 'error' | 'success';
  title: string;
  lines: string[];
}

interface CommandPaletteProps {
  commandInput: string;
  isCommandMode: boolean;
  commandResult?: CommandResult | null;
  selectedCommandIndex?: number;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  commandInput,
  isCommandMode,
  commandResult,
  selectedCommandIndex = 0,
}) => {
  const query = commandInput.trim().toLowerCase();
  const matches = AVAILABLE_COMMANDS.filter((cmd) => {
    if (!query || query === '/') return true;
    if (cmd.name.toLowerCase().startsWith(query)) return true;
    if (cmd.name.toLowerCase().includes(query)) return true;
    if (cmd.aliases?.some((a) => a.toLowerCase().startsWith(query) || a.toLowerCase().includes(query))) return true;
    return false;
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Command Result Output Box */}
      {commandResult && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={
            commandResult.type === 'usage'
              ? 'cyan'
              : commandResult.type === 'error'
              ? 'red'
              : commandResult.type === 'success'
              ? 'green'
              : 'yellow'
          }
          paddingX={1}
          marginBottom={1}
        >
          <Text bold color="white">
            {commandResult.title}
          </Text>
          {commandResult.lines.map((line, idx) => (
            <Text
              key={idx}
              color={
                line.startsWith('●')
                  ? 'cyan'
                  : line.startsWith('⏳')
                  ? 'yellow'
                  : line.startsWith('✓')
                  ? 'green'
                  : line.startsWith('⚠️') || line.startsWith('❌')
                  ? 'red'
                  : 'gray'
              }
            >
              {line}
            </Text>
          ))}
        </Box>
      )}

      {/* Filtered Command List Dropdown when Palette is active */}
      {isCommandMode && (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
          <Box marginBottom={0}>
            <Text bold color="cyan">
              COMMAND PALETTE (type to filter, [Tab] autocomplete, [Enter] run, [Esc] cancel):
            </Text>
          </Box>
          {matches.length === 0 ? (
            <Text color="gray">  No commands matching "{commandInput}"</Text>
          ) : (
            matches.map((cmd, idx) => {
              const isSelected = idx === selectedCommandIndex;
              const prefix = isSelected ? '❯ ' : '  ';
              return (
                <Box key={cmd.name} flexDirection="row">
                  <Box width={12}>
                    <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
                      {prefix}{cmd.name}
                    </Text>
                  </Box>
                  <Text color={isSelected ? 'white' : 'gray'}>
                    {cmd.description}
                  </Text>
                </Box>
              );
            })
          )}
        </Box>
      )}

      {/* Command Input Bar or Default Navigation Hints */}
      <Box
        flexDirection="row"
        borderStyle="single"
        borderColor={isCommandMode ? 'cyan' : 'gray'}
        paddingX={1}
      >
        {isCommandMode ? (
          <Box flexDirection="row">
            <Text bold color="cyan">
              {'❯ Command: '}
            </Text>
            <Text color="white">{commandInput}</Text>
            <Text bold color="cyan">_</Text>
            {matches.length > 0 && query && query !== matches[0].name && (
              <Text color="gray">  (press [Tab] for {matches[0].name})</Text>
            )}
          </Box>
        ) : (
          <Text color="cyan">
            [↑/↓ or j/k] Navigate  •  [Enter] Inspect  •  [/] Command Palette (/browse, /usage, /close)  •  [q] Quit
          </Text>
        )}
      </Box>
    </Box>
  );
};
