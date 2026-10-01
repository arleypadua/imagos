import type { AgentEvent } from './bus.js';

export type ParsedTranscriptEvent = Pick<AgentEvent, 'type' | 'summary' | 'detail'>;

// Tool results can be whole files or huge command outputs; keep enough to read
// in the inspect view without letting a single event balloon memory.
const MAX_RESULT_CHARS = 50_000;

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
        if (part?.type === 'image') return '[image]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function capText(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  const omitted = text.length - MAX_RESULT_CHARS;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n… [${omitted} more characters truncated]`;
}

/**
 * Converts one parsed line of a Claude session JSONL transcript into agent events.
 * Summaries stay short (used by Telegram and compact views); `detail` carries the
 * full tool input / result for the TUI inspect view.
 */
export function parseClaudeTranscriptEntry(parsed: any): ParsedTranscriptEvent[] {
  const events: ParsedTranscriptEvent[] = [];
  const content = parsed?.message?.content;
  if (!Array.isArray(content)) return events;

  if (parsed.type === 'assistant') {
    for (const block of content) {
      if (block.type === 'tool_use') {
        const inputSummary = block.input ? JSON.stringify(block.input).slice(0, 100) : '';
        events.push({
          type: 'tool_start',
          summary: `🔧 ${block.name}: ${inputSummary}`,
          detail: { name: block.name, input: block.input, toolUseId: block.id },
        });
      } else if (block.type === 'text' && block.text) {
        const text = block.text.trim();
        if (text) {
          events.push({ type: 'thought', summary: text });
        }
      }
    }
  } else if (parsed.type === 'user') {
    for (const block of content) {
      if (block.type === 'tool_result') {
        events.push({
          type: 'tool_end',
          summary: block.is_error ? `✗ Tool error` : `✓ Tool result received`,
          detail: {
            toolUseId: block.tool_use_id,
            isError: !!block.is_error,
            content: capText(toolResultText(block.content)),
          },
        });
      }
    }
  }

  return events;
}
