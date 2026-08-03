# Frontend Model Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users pick an allowlisted chat LLM model per message in the web composer; default always `OPENAI_MODEL`.

**Architecture:** Env allowlist (`OPENAI_MODELS`) + `GET /api/models` + optional `modelId` on `POST .../messages`. Server validates against allowlist, sets `agent.state.model` before each `prompt()`. Frontend single-select resets to default after each send.

**Tech Stack:** NestJS API, vitest, React/Vite web app, pi-agent-core.

**Spec:** `docs/superpowers/specs/2026-07-31-frontend-model-selection-design.md`

---

### Task 1: Allowlist helpers + unit tests

**Files:**
- Create: `apps/api/test/pi-model.spec.ts`
- Modify: `apps/api/src/agent/pi-model.ts`
- Modify: `.env.example`

- [x] Tests for parse/resolve allowlist
- [x] Implement `getDefaultModelId`, `resolveModelAllowlist`, `isModelAllowed`, `buildPiModel`
- [x] Document `OPENAI_MODELS` in `.env.example`

### Task 2: Wire model through chat + agent

**Files:**
- Create: `apps/api/src/models/models.controller.ts` (or chat-adjacent)
- Modify: `chat.dto.ts`, `chat.controller.ts`, `chat.service.ts`, `agent.service.ts`, modules

- [x] `GET /api/models`
- [x] Optional `modelId` on post; validate before user message create
- [x] Pass model into agent run; set state before prompt

### Task 3: Frontend picker

**Files:**
- Modify: `apps/web/src/services/api.ts`, `App.tsx`, `styles/index.css`

- [x] API client
- [x] Picker UI (hide if ≤1 model)
- [x] Send modelId; reset to default after send completes

### Task 4: Verify

- [x] Run unit tests for allowlist
- [x] Typecheck / build as needed
