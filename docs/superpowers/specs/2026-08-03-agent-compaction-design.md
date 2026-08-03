# Lightweight Agent Compaction (Bare Agent)

**Date:** 2026-08-03  
**Status:** Implemented  
**Approach:** Scheme 1 — compact on bare `Agent` + existing `AgentSessionPool` (no `AgentHarness`).

## Goal

Prevent long-lived pooled agents from blowing the model context with multi-turn RAG tool results, without migrating to harness session trees.

## Design

| Item | Choice |
|------|--------|
| When | Before each `agent.prompt()` (not mid-turn) |
| Where | In-memory `agent.state.messages` only |
| Postgres | Unchanged (user/assistant text only) |
| Runtime | Existing `Agent` + pool |
| Summary | OpenAI-compatible `chat/completions` call |
| Fallback | If summarize fails: hard-drop older messages, keep recent tail |

### Threshold

```
if AGENT_COMPACTION_THRESHOLD_TOKENS set → use it
else → min(contextWindow - reserveTokens, 150_000)
compact when estimatedTokens > threshold
```

Token estimate: conservative `ceil(chars / 4)` (same spirit as pi-agent-core).

### Cut point

Keep approximately `keepRecentTokens` from the end. Snap to a user turn boundary; never orphan `toolResult` messages from their assistant tool-call message.

### Replacement shape

```
[ user: "<summary>…checkpoint…</summary>" ]  // marked _compaction
+ recent messages tail
```

Uses a normal `user` role so bare Agent `convertToLlm` keeps it (no `compactionSummary` role).

## Config (env)

| Env | Default |
|-----|---------|
| `AGENT_COMPACTION_ENABLED` | `true` |
| `AGENT_COMPACTION_THRESHOLD_TOKENS` | unset → practical default above |
| `AGENT_COMPACTION_RESERVE_TOKENS` | `16384` |
| `AGENT_COMPACTION_KEEP_RECENT_TOKENS` | `20000` |

## Files

- `apps/api/src/agent/agent-compaction.ts` — pure logic + summarizer
- `apps/api/src/agent/agent.service.ts` — `maybeCompactAgent` before prompt
- `apps/api/test/agent-compaction.spec.ts` — unit tests

## Non-goals (this iteration)

- AgentHarness / session tree / navigateTree
- Mid-run `transformContext` compaction
- Persisting compaction summaries to Postgres
- Branch summarization
