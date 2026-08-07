import { useEffect, useState } from 'react';

export type AgentStepStatus = 'running' | 'done' | 'error' | 'info';

export type AgentProcessStep = {
  id: string;
  kind: 'thinking' | 'tool' | 'writing' | 'status';
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
  /** Citation count when known (for done summary). */
  sourceCount?: number;
};

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  if (ms < 1000) {
    const tenths = Math.max(0.1, Math.round(ms / 100) / 10);
    return tenths < 1 ? `${tenths.toFixed(1)}s` : '1s';
  }
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function formatDurationLong(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const sec = Math.max(1, Math.round(ms / 1000));
  return sec === 1 ? '1 second' : `${sec} seconds`;
}

function stepDurationMs(step: AgentProcessStep, now: number): number {
  return (step.endedAt ?? now) - step.startedAt;
}

function stepTitle(step: AgentProcessStep, now: number): string {
  const ms = stepDurationMs(step, now);
  if (step.kind === 'thinking') {
    if (step.status === 'running') return `Thinking… ${formatDuration(ms)}`;
    return `Thought for ${formatDurationLong(ms)}`;
  }
  if (step.kind === 'writing') {
    if (step.status === 'running') return `Writing answer… ${formatDuration(ms)}`;
    return `Wrote answer · ${formatDuration(ms)}`;
  }
  if (step.kind === 'status') {
    return step.label;
  }
  if (step.status === 'running') return `${step.label}… ${formatDuration(ms)}`;
  if (step.status === 'error') return `${step.label} (failed) · ${formatDuration(ms)}`;
  return `${step.label} · ${formatDuration(ms)}`;
}

const TOOL_LABELS: Record<string, string> = {
  retrieve_chunks: 'Retrieve chunks',
  keyword_search: 'Keyword search',
  summarize_document: 'Summarize document',
  profile_update: 'Update profile',
  memory_save: 'Save memory',
  memory_forget: 'Forget memory',
  memory_list: 'List memories',
};

export function friendlyToolName(name: string): string {
  const key = (name || '').trim();
  if (TOOL_LABELS[key]) return TOOL_LABELS[key];
  return key.replace(/_/g, ' ') || 'tool';
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
  summary?: string,
): AgentProcessState | null {
  if (!prev || prev.status === 'done') return prev;
  const now = Date.now();
  const friendly = friendlyToolName(toolName);
  const detailText =
    typeof summary === 'string' && summary.trim() ? summary.trim() : undefined;
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
        detail: detailText,
      };
    }
    return s;
  });
  steps.reverse();
  if (!matched) {
    let closed = false;
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].kind === 'tool' && steps[i].status === 'running') {
        steps[i] = {
          ...steps[i],
          status: ok ? 'done' : 'error',
          endedAt: now,
          detail: detailText,
        };
        closed = true;
        break;
      }
    }
    if (!closed) {
      steps.push({
        id: `tool-${toolName}-end-${now}`,
        kind: 'tool',
        label: friendly,
        detail: detailText,
        status: ok ? 'done' : 'error',
        startedAt: now,
        endedAt: now,
      });
    }
  }
  return { ...prev, steps };
}

export function applyAgentStatus(
  prev: AgentProcessState | null,
  kind: 'limit' | 'aborted' | 'info',
  message: string,
): AgentProcessState | null {
  if (!prev) return prev;
  const now = Date.now();
  const text = (message || '').trim() || 'Agent status';
  const last = prev.steps[prev.steps.length - 1];
  if (
    last?.kind === 'status' &&
    last.label === text &&
    last.detail === kind
  ) {
    return prev;
  }
  const steps = prev.steps.map((s) =>
    s.status === 'running' && s.kind !== 'writing'
      ? { ...s, status: 'done' as const, endedAt: now }
      : s,
  );
  return {
    ...prev,
    steps: [
      ...steps,
      {
        id: `status-${kind}-${now}`,
        kind: 'status',
        label: text,
        detail: kind,
        status: kind === 'info' ? 'info' : 'error',
        startedAt: now,
        endedAt: now,
      },
    ],
  };
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
  opts?: { sourceCount?: number },
): AgentProcessState | null {
  if (!prev) return prev;
  const now = Date.now();
  return {
    ...prev,
    status: 'done',
    ...(typeof opts?.sourceCount === 'number'
      ? { sourceCount: opts.sourceCount }
      : {}),
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

/** pi-web-style process details: text toggle + expandable tool rows + thinking pills. */
export default function AgentProcessPanel({ process }: Props) {
  const running = process.status === 'running';
  const [expanded, setExpanded] = useState(running);
  const [now, setNow] = useState(Date.now());
  const [openStepIds, setOpenStepIds] = useState<Record<string, boolean>>({});

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
  const toolCount = process.steps.filter((s) => s.kind === 'tool').length;
  const sourceCount = process.sourceCount ?? 0;
  const hasError = process.steps.some((s) => s.status === 'error');
  const totalMs = Math.max(
    0,
    (running
      ? now
      : process.steps.reduce(
          (end, s) => Math.max(end, s.endedAt ?? 0),
          process.startedAt,
        )) - process.startedAt,
  );
  const timePart = formatDuration(totalMs);

  let summary: string;
  if (running) {
    summary =
      toolCount > 0
        ? `Running · ${toolCount} tool${toolCount === 1 ? '' : 's'} · ${timePart}`
        : stepCount <= 1
          ? `Agent working… ${timePart}`
          : `Running · ${stepCount} step${stepCount === 1 ? '' : 's'} · ${timePart}`;
  } else {
    const parts = [
      'Process details',
      `${stepCount} step${stepCount === 1 ? '' : 's'}`,
    ];
    if (toolCount > 0) {
      parts.push(`${toolCount} tool${toolCount === 1 ? '' : 's'}`);
    }
    parts.push(timePart);
    if (sourceCount > 0) {
      parts.push(`${sourceCount} source${sourceCount === 1 ? '' : 's'}`);
    }
    if (hasError) parts.push('warnings');
    summary = parts.join(' · ');
  }

  return (
    <div
      className={`agent-process ${running ? 'is-running' : 'is-done'} ${
        expanded ? 'is-expanded' : 'is-collapsed'
      } ${hasError && !running ? 'has-warning' : ''}`}
    >
      <button
        type="button"
        className="agent-process-toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        title={expanded ? 'Collapse process' : 'Expand process'}
      >
        <svg
          className="agent-process-chevron-icon"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          style={{
            transform: expanded ? 'rotate(90deg)' : 'none',
          }}
        >
          <polyline points="4 2.5 7.5 6 4 9.5" />
        </svg>
        <span className="agent-process-summary">
          {running && <span className="agent-process-spinner" aria-hidden />}
          <span className="agent-process-summary-text">{summary}</span>
        </span>
      </button>

      {expanded && (
        <div className="agent-process-steps">
          {process.steps.map((step) => {
            const isTool = step.kind === 'tool';
            const stepOpen = Boolean(openStepIds[step.id]);
            const ms = stepDurationMs(step, now);
            const isError = step.status === 'error';
            const detail =
              isTool && step.detail && step.status !== 'running'
                ? step.detail
                : null;

            if (isTool) {
              return (
                <div
                  key={step.id}
                  className={`agent-process-tool status-${step.status}`}
                >
                  <button
                    type="button"
                    className="agent-process-tool-header"
                    onClick={() =>
                      setOpenStepIds((prev) => ({
                        ...prev,
                        [step.id]: !prev[step.id],
                      }))
                    }
                    aria-expanded={stepOpen}
                  >
                    <span className="agent-process-tool-name">
                      {step.status === 'running' ? (
                        <span className="agent-process-spinner sm" aria-hidden />
                      ) : null}
                      {step.label}
                    </span>
                    <span className="agent-process-tool-preview">
                      {step.status === 'running'
                        ? 'running…'
                        : detail || (isError ? 'failed' : 'done')}
                    </span>
                    <span className="agent-process-tool-time">
                      {formatDuration(ms)}
                    </span>
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 10 10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                      style={{
                        transform: stepOpen ? 'rotate(180deg)' : 'none',
                        transition: 'transform 0.15s',
                        flexShrink: 0,
                        opacity: 0.55,
                      }}
                    >
                      <polyline points="2 3.5 5 6.5 8 3.5" />
                    </svg>
                  </button>
                  {stepOpen && detail && (
                    <pre className="agent-process-tool-detail">{detail}</pre>
                  )}
                </div>
              );
            }

            if (step.kind === 'thinking' || step.kind === 'writing') {
              return (
                <div
                  key={step.id}
                  className={`agent-process-pill status-${step.status} kind-${step.kind}`}
                >
                  {step.status === 'running' && (
                    <span className="agent-process-spinner sm" aria-hidden />
                  )}
                  <span className="agent-process-pill-label">
                    {stepTitle(step, now)}
                  </span>
                </div>
              );
            }

            return (
              <div
                key={step.id}
                className={`agent-process-meta-step status-${step.status} kind-${step.kind}`}
              >
                <span className="agent-process-meta-label">
                  {stepTitle(step, now)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
