# RAG Quality P0

**Branch:** `feat/rag-quality-p0`  
**Date:** 2026-07-28  
**Status:** Implemented (server defaults + agent path)

**Full roadmap (P0–P3):** [`./2026-07-28-rag-quality-roadmap.md`](./2026-07-28-rag-quality-roadmap.md)  
**P1 design:** [`./2026-07-28-rag-quality-p1-design.md`](./2026-07-28-rag-quality-p1-design.md)  
**P2 design (ingest):** [`./2026-07-28-rag-quality-p2-design.md`](./2026-07-28-rag-quality-p2-design.md)  
**P3 design (eval/debug):** [`./2026-07-28-rag-quality-p3-design.md`](./2026-07-28-rag-quality-p3-design.md)  
**Implementation plan:** [`../plans/2026-07-28-rag-quality.md`](../plans/2026-07-28-rag-quality.md)

## Goals

Lift retrieval quality without replacing RAGFlow, inspired by WeKnora patterns:

1. Over-retrieve + hybrid weights + optional rerank
2. Similarity threshold + structured evidence for the LLM
3. Multi-query merge/dedupe
4. Multi-turn query rewrite hint for the agent

## Env knobs

See root `.env.example`:

| Variable | Default | Meaning |
|----------|---------|---------|
| `RAG_PAGE_SIZE` | 10 | Evidence chunks returned to agent |
| `RAG_TOP_K` | 30 | RAGFlow candidate pool (`top_k`) |
| `RAG_SIMILARITY_THRESHOLD` | 0.2 | Min similarity |
| `RAG_VECTOR_SIMILARITY_WEIGHT` | 0.7 | Hybrid vector vs keyword |
| `RAG_RERANK_ID` | (empty) | RAGFlow rerank model id |
| `RAG_MAX_CHUNK_CHARS` | 1200 | Truncation in tool text |
| `RAG_MULTI_QUERY` | true | Split multi-part / accept `queries[]` |
| `RAG_MULTI_QUERY_MAX` | 3 | Max queries per tool call |
| `RAG_QUERY_REWRITE` | true | LLM rewrite before agent prompt |

## Code map

| Path | Role |
|------|------|
| `apps/api/src/rag/rag-config.ts` | Env defaults |
| `apps/api/src/rag/evidence.ts` | Format / dedupe / threshold / citations |
| `apps/api/src/rag/query-rewrite.ts` | Multi-turn rewrite via OpenAI-compatible API |
| `apps/api/src/ragflow/ragflow.service.ts` | Full retrieval body |
| `apps/api/src/agent/agent.tools.ts` | `retrieve_chunks` evidence path |
| `apps/api/src/agent/agent.service.ts` | Inject rewrite hint when KBs selected |

## Out of scope (later)

Tracked as **P1–P3** in the [roadmap](./2026-07-28-rag-quality-roadmap.md):

- Keyword/grep + list-chunks tools — P1 (Fast RAG path not adopted)

- Chunking presets in product UI — P2
- Eval golden set + retrieval debug UI — P3
