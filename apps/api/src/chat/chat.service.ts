import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AgentService } from '../agent/agent.service';
import type { CitationSource } from '../agent/agent.tools';
import { notFound } from '../common/errors';
import { FastRagService } from '../rag/fast-rag.service';

export type ChatMode = 'agent' | 'fast';

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AgentService,
    private readonly fastRag: FastRagService,
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
    mode: ChatMode = 'agent',
  ) {
    const c = await this.getOwned(userId, conversationId);
    const selectedIds = (knowledgeBaseIds || []).filter(Boolean);
    const chatMode: ChatMode = mode === 'fast' ? 'fast' : 'agent';

    const userMeta: Record<string, unknown> = {};
    if (selectedIds.length) userMeta.knowledgeBaseIds = selectedIds;
    if (chatMode !== 'agent') userMeta.mode = chatMode;

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
    try {
      if (chatMode === 'fast') {
        for await (const ev of this.fastRag.run(
          userId,
          history,
          content,
          selectedIds,
        )) {
          if (ev.type === 'text_delta') {
            full += ev.delta;
            yield { event: 'text_delta', data: { delta: ev.delta } };
          } else if (ev.type === 'sources') {
            sources = ev.sources;
            yield { event: 'sources', data: { sources: ev.sources } };
          } else if (ev.type === 'error') {
            yield { event: 'error', data: { message: ev.message } };
          } else if (ev.type === 'done') {
            full = ev.fullText || full;
            if (ev.sources?.length) sources = ev.sources;
          }
        }
      } else {
        for await (const ev of this.agent.run(
          userId,
          conversationId,
          history,
          content,
          { knowledgeBaseIds: selectedIds },
        )) {
          if (ev.type === 'text_delta') {
            full += ev.delta;
            yield { event: 'text_delta', data: { delta: ev.delta } };
          } else if (ev.type === 'tool_start') {
            yield { event: 'tool_start', data: { name: ev.name } };
          } else if (ev.type === 'tool_end') {
            yield { event: 'tool_end', data: { name: ev.name, ok: ev.ok } };
          } else if (ev.type === 'sources') {
            sources = ev.sources;
            yield { event: 'sources', data: { sources: ev.sources } };
          } else if (ev.type === 'error') {
            yield { event: 'error', data: { message: ev.message } };
          } else if (ev.type === 'done') {
            full = ev.fullText || full;
            if (ev.sources?.length) sources = ev.sources;
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      yield { event: 'error', data: { message } };
      full = full || `Error: ${message}`;
    }

    const metadata: Record<string, unknown> = {};
    if (sources.length) metadata.sources = sources;
    if (selectedIds.length) metadata.knowledgeBaseIds = selectedIds;
    if (chatMode !== 'agent') metadata.mode = chatMode;

    const assistant = await this.prisma.message.create({
      data: {
        conversationId: c.id,
        role: 'assistant',
        content: full || '(empty)',
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
    await this.prisma.conversation.update({
      where: { id: c.id },
      data: { updatedAt: new Date() },
    });

    yield {
      event: 'assistant_message',
      data: {
        id: assistant.id,
        role: 'assistant',
        content: assistant.content,
        sources,
        createdAt: assistant.createdAt.toISOString(),
      },
    };
    yield { event: 'done', data: {} };
  }
}
