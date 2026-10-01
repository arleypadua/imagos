import { EventEmitter } from 'node:events';

export type AgentEventType =
  | 'tool_start'
  | 'tool_end'
  | 'thought'
  | 'stdout'
  | 'stderr'
  | 'status'
  | 'info'
  | 'prompt_injected'
  | 'git_diff';

export interface AgentEvent {
  id: string;
  issueNumber: number;
  type: AgentEventType;
  timestamp: string;
  summary: string;
  detail?: any;
}

// Enough to hold a full agent session for the inspect view while staying bounded.
export const MAX_EVENT_HISTORY_PER_ISSUE = 2000;

export class AgentEventBus extends EventEmitter {
  private static instance?: AgentEventBus;
  private eventHistory: Map<number, AgentEvent[]> = new Map();
  private maxHistoryPerIssue = MAX_EVENT_HISTORY_PER_ISSUE;

  public static getInstance(): AgentEventBus {
    if (!AgentEventBus.instance) {
      AgentEventBus.instance = new AgentEventBus();
    }
    return AgentEventBus.instance;
  }

  public emitAgentEvent(event: Omit<AgentEvent, 'id' | 'timestamp'> & { timestamp?: string; id?: string }): AgentEvent {
    const fullEvent: AgentEvent = {
      id: event.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: event.timestamp || new Date().toLocaleTimeString(),
      issueNumber: event.issueNumber,
      type: event.type,
      summary: event.summary,
      detail: event.detail,
    };

    const history = this.eventHistory.get(fullEvent.issueNumber) || [];
    history.push(fullEvent);
    if (history.length > this.maxHistoryPerIssue) {
      history.shift();
    }
    this.eventHistory.set(fullEvent.issueNumber, history);

    this.emit('agent_event', fullEvent);
    this.emit(`issue:${fullEvent.issueNumber}`, fullEvent);

    return fullEvent;
  }

  public getHistory(issueNumber: number): AgentEvent[] {
    return this.eventHistory.get(issueNumber) || [];
  }

  public clearHistory(issueNumber?: number): void {
    if (issueNumber !== undefined) {
      this.eventHistory.delete(issueNumber);
    } else {
      this.eventHistory.clear();
    }
  }
}
