# Agent Product Positioning — KB Solver vs General Computer Agent

**Date:** 2026-08-06  
**Status:** Reference / product decision  
**Product:** CSB Knowledge Base Portal (`pi-rag`)  
**Related:**  
- Session workspace + analyze: [`2026-08-06-session-workspace-analyze-design.md`](./2026-08-06-session-workspace-analyze-design.md)  
- Core portal design: [`2026-07-23-pi-rag-design.md`](./2026-07-23-pi-rag-design.md)

---

## 1. Why this note exists

When improving chat quality, it is easy to blur two different products:

1. **Knowledge portal agent** — answer and analyze *within user knowledge bases*.
2. **General computer agent** — open-ended tasks with a virtual machine, browser, long-running projects (e.g. Manus-style **Computer** mode).

This note records the distinction, using a real UI reference, so implementation stays aligned with pi-rag’s security and architecture.

---

## 2. Reference UI (general Computer agent)

Example product pattern (Manus-class “Computer” chat):

| UI element | Role |
|------------|------|
| Mode label **Computer** | Computer-use: browser, files, terminal, multi-step execution on a sandbox machine |
| **搜尋 / Search** | Web search |
| **在專案中工作 / Work in project** | Persistent or semi-persistent **project workspace** for artifacts |
| **協調器 / Coordinator** | Planner / multi-role orchestration, not single-shot retrieval |
| Task chips (e.g. 复现论文、可视化数据、创建报告、创办一家公司) | Open-ended long-horizon goals, not limited to a document set |

```text
User task
  → Coordinator plans
  → Computer tools (browser, shell, files, code, search)
  → Project workspace accumulates intermediate work
  → Long-running multi-step outcome
```

This is a **general-purpose / computer-use agent** (high ceiling, high isolation cost).

**Screenshot reference (local):** `c:\Users\Admin\Downloads\1.jpg` (not checked into the repo).  
Product family: Manus-like Computer mode with project + coordinator + search.

---

## 3. Three agent shapes (use this vocabulary)

| Level | Name | Typical tools | Fit for pi-rag |
|-------|------|---------------|----------------|
| **A** | Knowledge Q&A agent | `retrieve_chunks`, `keyword_search`, `summarize_document`, memory | **Today** |
| **B** | Knowledge problem solver | A + session workspace + inspect/materialize/`query_table` (+ later limited sandbox on KB data) | **Near-term target** ([analyze design](./2026-08-06-session-workspace-analyze-design.md)) |
| **C** | General computer agent | Browser, arbitrary shell, multi-day projects, “start a company” | **Out of scope for default pi-rag** |

```text
C  Manus Computer / open digital employee
      ↑ much wider tool surface + VM isolation
B  Session workspace + analyze (KB-bound compute)
      ↑ deterministic table/stats; thin scratch workspace
A  RAG retrieve / keyword / summarize
```

---

## 4. Side-by-side

| Dimension | Computer agent (C) | pi-rag target (B) | pi-rag today (A) |
|-----------|--------------------|-------------------|------------------|
| Primary job | Almost any delegated task | Look up, read, **compute** on *selected knowledge* | Look up / summarize docs |
| Workspace | Project-level, often long-lived | **Session-scoped** scratch (`inputs/` / `derived/`) | None |
| Tools | Browser, code, OS-like ops | Materialize table, query, optional sandboxed analysis on exports | Retrieval + memory |
| Data boundary | User uploads + web + VM disk | **Owned/shared KBs + conversation artifacts only** | Same KBs, chunks only |
| Security | Strong VM isolation, high ops cost | Nest ownership + path chroot + row/byte caps | Nest ownership |
| “最悠久的员工” | Can open file, run pandas, write report | `materialize` + `query_table` / preset | Search chunks — wrong tool |
| “创办一家公司” | In product scope | **Not** in product scope | Not in scope |

---

## 5. Locked product decision for pi-rag

1. **Default agent remains a knowledge assistant**, not a general digital employee.
2. **Upgrade path is A → B**, not A → C in one jump.
3. **Workspace is thin and conversation-bound** (see analyze design). It supports tools; it is not a full IDE/project product in Phase 1–2.
4. **Do not** add arbitrary shell, unrestricted network browse, or “coordinator for any life goal” to the default tool set without a separate product/security design.
5. Marketing / system prompt language: prefer **“在知识库中查找、阅读与分析”**; avoid promising **“Computer / 操作你的电脑 / 任意任务”**.

### Acceptable later expansions (still B-shaped)

- Download analysis CSV from session artifacts  
- Limited sandbox code **only** on workspace + authorized document exports  
- Stronger multi-step planning **inside** KB tasks (compare docs, build report from sources)

### Requires a separate product track (C-shaped)

- Virtual desktop / browser automation for arbitrary sites  
- Persistent multi-user “projects” unrelated to KB ownership  
- Task marketplace chips like “创办一家公司” as first-class UX  

If C is ever needed, treat it as **another product or mode** with its own isolation budget—not a silent expansion of `createUserTools`.

---

## 6. How this maps to implementation docs

| Need | Doc |
|------|-----|
| Session workspace, analyze tools, routing | [`2026-08-06-session-workspace-analyze-design.md`](./2026-08-06-session-workspace-analyze-design.md) |
| Implementation checklist | [`../plans/2026-08-06-session-workspace-analyze.md`](../plans/2026-08-06-session-workspace-analyze.md) |
| Why pure retrieve fails on global stats | Same analyze design §2 |
| Why we refuse Manus-parity by default | **This document** |

---

## 7. One-line summary

**Manus-style Computer = general agent (C).**  
**pi-rag near-term = knowledge problem solver (B): session workspace + compute on authorized knowledge, still RAGFlow-first and ownership-bound.**  
Do not confuse “more general than search” with “full computer-use agent.”
