import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { InspectView, buildInspectLines, clampScrollTop } from '../src/ui/tui/InspectView.js';
import { parseClaudeTranscriptEntry } from '../src/events/claude_transcript.js';
import type { AgentEvent } from '../src/events/bus.js';

const worker = { issueNumber: 68, title: 'Plug-in actions', branchName: 'agent/issue-68', status: 'running' as const };

function evt(partial: Partial<AgentEvent> & Pick<AgentEvent, 'type' | 'summary'>, i = 0): AgentEvent {
  return { id: `e-${i}-${partial.type}`, issueNumber: 68, timestamp: '5:32:24 PM', ...partial };
}

describe('parseClaudeTranscriptEntry', () => {
  it('keeps full tool input and tool result content in detail', () => {
    const [start] = parseClaudeTranscriptEntry({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'x'.repeat(300) } }] },
    });
    expect(start.type).toBe('tool_start');
    expect(start.detail.input.command).toHaveLength(300);
    expect(start.detail.toolUseId).toBe('tu_1');

    const [end] = parseClaudeTranscriptEntry({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'line1\nline2' }] }] },
    });
    expect(end.type).toBe('tool_end');
    expect(end.detail.content).toBe('line1\nline2');
  });
});

describe('InspectView full log rendering', () => {
  it('renders long agent messages in full across wrapped lines', () => {
    const long = `I didn't implement #68 because its blocker hasn't landed yet. ${'more words here '.repeat(20)}THE-END`;
    const lines = buildInspectLines([evt({ type: 'thought', summary: long })], 80, false);
    const joined = lines.map((l) => l.text).join('');
    expect(joined).toContain('THE-END');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0].gutter).toBe('[5:32:24 PM] ');
    expect(lines[1].gutter.trim()).toBe('');
  });

  it('prettifies Edit tool calls as a diff and names the tool on its result', () => {
    const events = [
      evt({ type: 'tool_start', summary: '🔧 Edit', detail: { name: 'Edit', toolUseId: 't1', input: { file_path: 'src/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' } } }, 1),
      evt({ type: 'tool_end', summary: '✓ Tool result received', detail: { toolUseId: 't1', content: 'ok' } }, 2),
    ];
    const texts = buildInspectLines(events, 100, false).map((l) => l.text);
    expect(texts).toContain('🔧 Edit  src/a.ts');
    expect(texts).toContain('- const a = 1;');
    expect(texts).toContain('+ const a = 2;');
    expect(texts).toContain('✓ Edit result (1 line)');
  });

  it('collapses long tool results until expanded', () => {
    const content = Array.from({ length: 50 }, (_, i) => `row ${i}`).join('\n');
    const events = [evt({ type: 'tool_end', summary: '✓', detail: { content } })];
    const collapsed = buildInspectLines(events, 100, false).map((l) => l.text);
    expect(collapsed.some((t) => t.includes('38 more lines'))).toBe(true);
    const expanded = buildInspectLines(events, 100, true).map((l) => l.text);
    expect(expanded).toContain('│ row 49');
  });

  it('follows the tail by default and can scroll to the top', () => {
    const events = Array.from({ length: 60 }, (_, i) => evt({ type: 'stdout', summary: `message ${i}` }, i));
    const tail = render(<InspectView worker={worker} events={events} inputText="" isSubmitting={false} />).lastFrame()!;
    expect(tail).toContain('message 59');
    expect(tail).not.toContain('message 0\n');
    expect(tail).toContain('following');

    const top = render(<InspectView worker={worker} events={events} inputText="" isSubmitting={false} scrollTop={0} />).lastFrame()!;
    expect(top).toContain('message 0');
    expect(top).not.toContain('message 59');
    expect(clampScrollTop(1000, 60, 10)).toBe(50);
  });
});
