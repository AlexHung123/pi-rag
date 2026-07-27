# Pi Agent Pool Implementation Plan

> **For agentic workers:** Execute task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `@earendil-works/pi-agent-core` with a bounded in-memory conversation agent pool; tools = list KBs + retrieve; P0 Postgres persistence for user/assistant only.

**Architecture:** `AgentSessionPool` holds one `Agent` per conversation. `AgentService.run` acquires a session, hydrates on miss from DB history, calls `agent.prompt`, maps events to existing SSE. Chat dispose frees the pool slot.

**Tech Stack:** NestJS, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, existing Knowledge/Ragflow services.

**Spec:** `docs/superpowers/specs/2026-07-24-pi-agent-pool-design.md`

---

## File map

| File | Action |
|------|--------|
| `apps/api/package.json` | Add pi-agent-core, pi-ai |
| `apps/api/src/agent/pi-model.ts` | OpenAI-compatible provider factory |
| `apps/api/src/agent/agent-session.pool.ts` | Bounded pool |
| `apps/api/src/agent/agent.tools.ts` | List + retrieve only |
| `apps/api/src/agent/agent.service.ts` | Rewrite around pool + pi Agent |
| `apps/api/src/agent/agent.module.ts` | Register pool provider |
| `apps/api/src/chat/chat.service.ts` | dispose on delete; pass conversationId |
| `.env.example`, `README.md` | Pool env docs |

### Task 1: Dependencies + model factory + pool + tools + service + chat dispose

- [x] Install `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `typebox`
- [x] `pi-model.ts`, `agent-session.pool.ts`, slim tools, rewrite `agent.service.ts`
- [x] Chat dispose + `conversationId` on `run`
- [x] `npm run build -w @pi-rag/api` passes

### Task 2: Env/README + smoke build

- [x] `.env.example` pool vars
- [x] README agent/pool notes
- [x] Dynamic ESM import smoke for Agent / streamSimple

---
