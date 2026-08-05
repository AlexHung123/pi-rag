import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AgentService } from '../agent/agent.service';
import type { CitationSource } from '../agent/agent.tools';
import { badRequest, notFound } from '../common/errors';
import {
  getDefaultModelId,
  isModelAllowed,
} from '../agent/pi-model';
import { CHAT_MESSAGE_MAX_CHARS } from './chat.limits';

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AgentService,
  ) {}

  async list(userId: string) {
    const items = await this.prisma.conversation.findMany({
      where: { ownerUserId: userId },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { messages: true } } },
    });
    return items.map((c) => ({
      id: c.id,
      title: c.title,
      messageCount: c._count.messages,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }));
  }

  async create(userId: string, title?: string) {
    const c = await this.prisma.conversation.create({
      data: {
        ownerUserId: userId,
        title: (title || 'New chat').slice(0, 120),
      },
    });
    return {
      id: c.id,
      title: c.title,
      messageCount: 0,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      messages: [] as Array<{
        id: string;
        role: string;
        content: string;
        createdAt: string;
      }>,
    };
  }

  async getOwned(userId: string, id: string) {
    const c = await this.prisma.conversation.findFirst({
      where: { id, ownerUserId: userId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!c) throw notFound('conversation not found');
    return c;
  }

  async get(userId: string, id: string) {
    const c = await this.getOwned(userId, id);
    return {
      id: c.id,
      title: c.title,
      messageCount: c.messages.length,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      messages: c.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        metadata: m.metadata,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  async remove(userId: string, id: string) {
    await this.getOwned(userId, id);
    this.agent.disposeConversation(id);
    await this.prisma.conversation.delete({ where: { id } });
    return { ok: true };
  }

  async *streamMessage(
    userId: string,
    conversationId: string,
    content: string,
    knowledgeBaseIds?: string[],
    signal?: AbortSignal,
    modelId?: string,
    documentIds?: string[],
  ) {
    if (typeof content !== 'string' || !content.trim()) {
      throw badRequest('content is required');
    }
    if (content.length > CHAT_MESSAGE_MAX_CHARS) {
      throw badRequest(
        `content exceeds max length of ${CHAT_MESSAGE_MAX_CHARS} characters`,
      );
    }
    const resolvedModelId = this.resolveModelId(modelId);
    const c = await this.getOwned(userId, conversationId);
    const selectedIds = (knowledgeBaseIds || []).filter(Boolean);
    const selectedDocIds = (documentIds || []).filter(Boolean);
    if (selectedDocIds.length && !selectedIds.length) {
      throw badRequest('documentIds require knowledgeBaseIds');
    }

    const userMeta: Record<string, unknown> = {};
    if (selectedIds.length) userMeta.knowledgeBaseIds = selectedIds;
    if (selectedDocIds.length) userMeta.documentIds = selectedDocIds;

    const userMsg = await this.prisma.message.create({
      data: {
        conversationId: c.id,
        role: 'user',
        content,
        metadata: Object.keys(userMeta).length
          ? (userMeta as Prisma.InputJsonValue)
          : undefined,
      },
    });

    if (c.title === 'New chat') {
      await this.prisma.conversation.update({
        where: { id: c.id },
        data: { title: content.slice(0, 48) || 'New chat' },
      });
    } else {
      await this.prisma.conversation.update({
        where: { id: c.id },
        data: { updatedAt: new Date() },
      });
    }

    yield {
      event: 'user_message',
      data: {
        id: userMsg.id,
        role: 'user',
        content: userMsg.content,
        createdAt: userMsg.createdAt.toISOString(),
      },
    };

    const historyLimit = Number(process.env.AGENT_HISTORY_LIMIT || 20);
    const limit =
      Number.isFinite(historyLimit) && historyLimit > 0 ? historyLimit : 20;

    const history = c.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-limit)
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    let full = '';
    let sources: CitationSource[] = [];
    let aborted = false;
    try {
      for await (const ev of this.agent.run(
        userId,
        conversationId,
        history,
        content,
        {
          knowledgeBaseIds: selectedIds,
          documentIds: selectedDocIds,
          signal,
          modelId: resolvedModelId,
        },
      )) {
        if (signal?.aborted) {
          aborted = true;
          break;
        }
        if (ev.type === 'text_delta') {
          full += ev.delta;
          yield { event: 'text_delta', data: { delta: ev.delta } };
        } else if (ev.type === 'tool_start') {
          yield { event: 'tool_start', data: { name: ev.name } };
        } else if (ev.type === 'tool_end') {
          yield {
            event: 'tool_end',
            data: {
              name: ev.name,
              ok: ev.ok,
              ...(ev.summary ? { summary: ev.summary } : {}),
              ...(typeof ev.hitCount === 'number'
                ? { hitCount: ev.hitCount }
                : {}),
            },
          };
        } else if (ev.type === 'agent_status') {
          yield {
            event: 'agent_status',
            data: { kind: ev.kind, message: ev.message },
          };
        } else if (ev.type === 'sources') {
          sources = ev.sources;
          yield { event: 'sources', data: { sources: ev.sources } };
        } else if (ev.type === 'error') {
          yield { event: 'error', data: { message: ev.message } };
        } else if (ev.type === 'done') {
          full = ev.fullText || full;
          if (ev.sources?.length) sources = ev.sources;
          if (ev.aborted) aborted = true;
        }
      }
    } catch (err) {
      if (signal?.aborted) {
        aborted = true;
      } else {
        const message = err instanceof Error ? err.message : String(err);
        yield { event: 'error', data: { message } };
        full = full || `Error: ${message}`;
      }
    }

    // Client may have aborted mid-stream; still persist partial assistant text.
    if (aborted || signal?.aborted) {
      aborted = true;
    }

    const metadata: Record<string, unknown> = {};
    if (sources.length) metadata.sources = sources;
    if (selectedIds.length) metadata.knowledgeBaseIds = selectedIds;
    if (selectedDocIds.length) metadata.documentIds = selectedDocIds;
    if (aborted) metadata.aborted = true;

    const assistantContent =
      full || (aborted ? '(stopped)' : '(empty)');

    const assistant = await this.prisma.message.create({
      data: {
        conversationId: c.id,
        role: 'assistant',
        content: assistantContent,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
    await this.prisma.conversation.update({
      where: { id: c.id },
      data: { updatedAt: new Date() },
    });

    // If the client already hung up, further writes may fail — that's fine.
    try {
      yield {
        event: 'assistant_message',
        data: {
          id: assistant.id,
          role: 'assistant',
          content: assistant.content,
          sources,
          aborted,
          createdAt: assistant.createdAt.toISOString(),
        },
      };
      yield { event: 'done', data: { aborted } };
    } catch {
      /* client gone */
    }
  }

  /**
   * Resolve optional client modelId against OPENAI_MODELS allowlist.
   * Omit/empty → default; unknown → 400 (before any message row is written).
   * Public so the controller can validate before opening the SSE stream.
   */
  resolveModelId(modelId?: string): string {
    const id = typeof modelId === 'string' ? modelId.trim() : '';
    if (!id) return getDefaultModelId();
    if (!isModelAllowed(id)) {
      throw badRequest('model not allowed');
    }
    return id;
  }
}
