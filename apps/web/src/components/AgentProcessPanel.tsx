import { useEffect, useState } from 'react';

export type AgentStepStatus = 'running' | 'done' | 'error';

export type AgentProcessStep = {
  id: string;
  kind: 'thinking' | 'tool' | 'writing';
  label: string;
  detail?: string;
  status: AgentStepStatus;
  startedAt: number;
  endedAt?: number;
};

export type AgentProcessState = {
  messageId: string;
  steps: AgentProcessStep[];
  status: 'running' | 'done';
  startedAt: number;
};

function formatDuration(ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000));
  return sec === 1 ? '1 second' : `${sec} seconds`;
}

function stepTitle(step: AgentProcessStep, now: number): string {
  if (step.kind === 'thinking') {
    if (step.status === 'running') return 'Thinking…';
    const ms = (step.endedAt ?? now) - step.startedAt;
    return `Thought for ${formatDuration(ms)}`;
  }
  if (step.kind === 'writing') {
    return step.status === 'running' ? 'Writing answer…' : 'Wrote answer';
  }
  // tool
  if (step.status === 'running') return step.label;
  if (step.status === 'error') return `${step.label} (failed)`;
  return step.label;
}

function friendlyToolName(name: string): string {
  const map: Record<string, string> = {
    retrieve_chunks: 'Retrieve chunks',
  };
  return map[name] || name.replace(/_/g, ' ');
}

export function createInitialProcess(messageId: string): AgentProcessState {
  const now = Date.now();
  return {
    messageId,
    status: 'running',
    startedAt: now,
    steps: [
      {
        id: `thinking-${now}`,
        kind: 'thinking',
        label: 'Thinking',
        status: 'running',
        startedAt: now,
      },
    ],
  };
}

export function applyToolStart(
  prev: AgentProcessState | null,
  toolName: string,
): AgentProcessState | null {
  if (!prev || prev.status === 'done') return prev;
  const now = Date.now();
  const name = friendlyToolName(toolName);
  const steps = prev.steps.map((s) =>
    s.status === 'running' && s.kind === 'thinking'
      ? { ...s, status: 'done' as const, endedAt: now }
      : s,
  );
  // Close any prior running tool of same wave
  const closed = steps.map((s) =>
    s.status === 'running' && s.kind === 'tool'
      ? { ...s, status: 'done' as const, endedAt: now }
      : s,
  );
  return {
    ...prev,
    steps: [
      ...closed,
      {
        id: `tool-${toolName}-${now}`,
        kind: 'tool',
        label: name,
        detail: toolName,
        status: 'running',
        startedAt: now,
      },
    ],
  };
}

export function applyToolEnd(
  prev: AgentProcessState | null,
  toolName: string,
  ok: boolean,
): AgentProcessState | null {
  if (!prev || prev.status === 'done') return prev;
  const now = Date.now();
  const friendly = friendlyToolName(toolName);
  let matched = false;
  const steps = [...prev.steps].reverse().map((s) => {
    if (
      !matched &&
      s.kind === 'tool' &&
      s.status === 'running' &&
      (s.detail === toolName || s.label === friendly)
    ) {
      matched = true;
      return {
        ...s,
        status: (ok ? 'done' : 'error') as AgentStepStatus,
        endedAt: now,
      };
    }
    return s;
  });
  steps.reverse();
  if (!matched) {
    // Fallback: close last running tool
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].kind === 'tool' && steps[i].status === 'running') {
        steps[i] = {
          ...steps[i],
          status: ok ? 'done' : 'error',
          endedAt: now,
        };
        break;
      }
    }
  }
  return { ...prev, steps };
}

export function applyTextStarted(
  prev: AgentProcessState | null,
): AgentProcessState | null {
  if (!prev || prev.status === 'done') return prev;
  if (prev.steps.some((s) => s.kind === 'writing')) return prev;
  const now = Date.now();
  const steps = prev.steps.map((s) =>
    s.status === 'running'
      ? { ...s, status: 'done' as const, endedAt: now }
      : s,
  );
  return {
    ...prev,
    steps: [
      ...steps,
      {
        id: `writing-${now}`,
        kind: 'writing',
        label: 'Writing answer',
        status: 'running',
        startedAt: now,
      },
    ],
  };
}

export function applyProcessDone(
  prev: AgentProcessState | null,
): AgentProcessState | null {
  if (!prev) return prev;
  const now = Date.now();
  return {
    ...prev,
    status: 'done',
    steps: prev.steps.map((s) =>
      s.status === 'running'
        ? { ...s, status: 'done' as const, endedAt: now }
        : s,
    ),
  };
}

type Props = {
  process: AgentProcessState;
};

export default function AgentProcessPanel({ process }: Props) {
  const running = process.status === 'running';
  const [expanded, setExpanded] = useState(running);
  const [now, setNow] = useState(Date.now());

  // While running, tick for live "Thinking…" duration and keep expanded
  useEffect(() => {
    if (!running) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [running]);

  const stepCount = process.steps.length;
  const summary = running
    ? stepCount <= 1
      ? 'Agent working…'
      : `Running · ${stepCount} steps`
    : `已完成 ${stepCount} 個步驟`;

  return (
    <div
      className={`agent-process ${running ? 'is-running' : 'is-done'} ${
        expanded ? 'is-expanded' : 'is-collapsed'
      }`}
    >
      <button
        type="button"
        className="agent-process-toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="agent-process-summary">
          {running && <span className="agent-process-spinner" aria-hidden />}
          {!running && <span className="agent-process-check" aria-hidden />}
          <span>{summary}</span>
        </span>
        <span className="agent-process-chevron" aria-hidden>
          {expanded ? '▾' : '›'}
        </span>
      </button>

      {expanded && (
        <ol className="agent-process-steps">
          {process.steps.map((step) => (
            <li
              key={step.id}
              className={`agent-process-step status-${step.status}`}
            >
              <span className="agent-process-step-icon" aria-hidden>
                {step.status === 'running' ? (
                  <span className="agent-process-spinner sm" />
                ) : step.status === 'error' ? (
                  <span className="agent-process-x" />
                ) : (
                  <span className="agent-process-check sm" />
                )}
              </span>
              <span className="agent-process-step-label">
                {stepTitle(step, now)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
