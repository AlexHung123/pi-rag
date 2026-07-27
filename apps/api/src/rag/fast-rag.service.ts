/**
 * Fast RAG path: rewrite → hybrid retrieve → evidence → stream LLM.
 * No pi-agent-core tool loop (lower latency for simple factual QA).
 */

import { Injectable, Logger } from '@nestjs/common';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { PrismaService } from '../prisma/prisma.service';
import { RagflowService } from '../ragflow/ragflow.service';
import { isLlmConfigured } from '../agent/pi-model';
import {
  dedupeHitsById,
  filterHitsByThreshold,
  formatEvidenceForModel,
  mappedHitsToCitationSources,
  type CitationSource,
  type MappedHit,
} from './evidence';
import { expandAdjacentHits } from './expand-hits';
import { getRagRetrievalConfig } from './rag-config';
import { rewriteQueryForRetrieval } from './query-rewrite';
import { resolveRetrievalScope } from './resolve-scope';

export type FastRagStreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'sources'; sources: CitationSource[] }
  | { type: 'done'; fullText: string; sources: CitationSource[] }
  | { type: 'error'; message: string };

const FAST_SYSTEM = `You are the CSB Knowledge Base Portal assistant answering from retrieved evidence only.

Language:
- Default language is Traditional Chinese (繁體中文). Reply in Traditional Chinese unless the user writes in English.
- If the user writes primarily in English, reply in English.

Rules:
- Use ONLY the evidence block provided. Cite as [1], [2], … matching source numbers.
- If evidence is missing or insufficient, say you do not know based on the selected knowledge bases. Do not invent facts.
- Be concise and practical. Mention document names when citing.`;

@Injectable()
export class FastRagService {
  private readonly logger = new Logger(FastRagService.name);

  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly ragflow: RagflowService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Stream a direct RAG answer for selected KBs (or pure chat when none selected).
   */
  async *run(
    userId: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    userMessage: string,
    knowledgeBaseIds: string[] = [],
  ): AsyncGenerator<FastRagStreamEvent> {
    if (!isLlmConfigured()) {
      const msg =
        'LLM is not configured. Set OPENAI_BASE_URL and/or OPENAI_API_KEY on the API.';
      yield { type: 'error', message: msg };
      yield { type: 'text_delta', delta: msg };
      yield { type: 'done', fullText: msg, sources: [] };
      return;
    }

    const selectedIds = (knowledgeBaseIds || []).filter(Boolean);
    let sources: CitationSource[] = [];
    let evidenceBlock = '';
    let searchQuery = userMessage.trim();

    if (selectedIds.length) {
      const scope = await resolveRetrievalScope(
        userId,
        selectedIds,
        this.knowledge,
        this.prisma,
      );

      if (!scope.ok) {
        // Soft message for the model — still stream a helpful reply.
        evidenceBlock = [
          'No accessible knowledge bases for this request.',
          scope.message,
          'Tell the user to select readable knowledge bases in the UI.',
        ].join('\n');
      } else {
        const rewritten = await rewriteQueryForRetrieval(userMessage, history);
        searchQuery = rewritten.rewriteQuery || userMessage.trim();
        if (rewritten.rewritten) {
          this.logger.debug(
            `fast-rag rewrite: "${rewritten.original.slice(0, 60)}" → "${searchQuery.slice(0, 60)}"`,
          );
        }

        const ragCfg = getRagRetrievalConfig();
        const pageSize = ragCfg.pageSize;
        const topK = Math.max(pageSize, ragCfg.topK);

        const hits = await this.ragflow.retrieve({
          datasetIds: scope.datasetIds,
          question: searchQuery,
          pageSize,
          topK,
          similarityThreshold: ragCfg.similarityThreshold,
          vectorSimilarityWeight: ragCfg.vectorSimilarityWeight,
          rerankId: ragCfg.rerankId,
        });

        let merged: MappedHit[] = hits.map((h) => scope.mapHit(h));
        merged = dedupeHitsById(merged);
        merged = filterHitsByThreshold(merged, ragCfg.similarityThreshold);
        merged = merged.slice(0, pageSize);
        merged = await expandAdjacentHits(merged, {
          listChunks: (datasetId, documentId, o) =>
            this.ragflow.listChunks(datasetId, documentId, o),
        });

        const maxScore = merged.reduce(
          (m, h) => Math.max(m, typeof h.score === 'number' ? h.score : 0),
          0,
        );
        const insufficient =
          merged.length === 0 ||
          (maxScore > 0 && maxScore < ragCfg.similarityThreshold + 0.1);

        sources = mappedHitsToCitationSources(merged);
        if (sources.length) {
          yield { type: 'sources', sources };
        }

        evidenceBlock = formatEvidenceForModel(merged, {
          maxChunkChars: ragCfg.maxChunkChars,
          query: searchQuery,
          insufficient,
          message:
            merged.length === 0
              ? 'No chunks passed the similarity threshold. Refuse to invent facts.'
              : undefined,
        });
      }
    }

    const systemParts = [FAST_SYSTEM];
    if (evidenceBlock) {
      systemParts.push('', '--- Retrieved evidence ---', evidenceBlock);
    } else {
      systemParts.push(
        '',
        'No knowledge bases selected. Answer as a general assistant without inventing private document content.',
      );
    }

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemParts.join('\n') },
    ];

    const historyLimit = Number(process.env.AGENT_HISTORY_LIMIT || 20);
    const limit =
      Number.isFinite(historyLimit) && historyLimit > 0 ? historyLimit : 20;
    for (const m of history.slice(-limit)) {
      messages.push({ role: m.role, content: m.content });
    }
    messages.push({ role: 'user', content: userMessage });

    try {
      let fullText = '';
      for await (const delta of this.streamChatCompletions(messages)) {
        fullText += delta;
        yield { type: 'text_delta', delta };
      }
      yield { type: 'done', fullText, sources };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`fast-rag stream failed: ${message}`);
      yield { type: 'error', message };
      yield { type: 'text_delta', delta: message };
      yield { type: 'done', fullText: message, sources };
    }
  }

  /** Thin OpenAI-compatible streaming helper (shared config with agent LLM). */
  private async *streamChatCompletions(
    messages: Array<{ role: string; content: string }>,
  ): AsyncGenerator<string> {
    const baseUrl = (
      process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
    ).replace(/\/$/, '');
    const model = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
    const apiKey = (process.env.OPENAI_API_KEY || '').trim();

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        stream: true,
        messages,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `LLM stream HTTP ${res.status}: ${text.slice(0, 240) || res.statusText}`,
      );
    }

    if (!res.body) {
      throw new Error('LLM stream returned no body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || !line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) {
            yield delta;
          }
        } catch {
          /* skip malformed SSE chunks */
        }
      }
    }

    // Flush trailing buffer
    if (buffer.trim().startsWith('data:')) {
      const payload = buffer.trim().slice(5).trim();
      if (payload && payload !== '[DONE]') {
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) yield delta;
        } catch {
          /* ignore */
        }
      }
    }
  }
}
