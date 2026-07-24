import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AgentService } from '../agent/agent.service';
import { notFound } from '../common/errors';

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
    });
    return items.map((c) => ({
      id: c.id,
      title: c.title,
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
    await this.prisma.conversation.delete({ where: { id } });
    return { ok: true };
  }

  async *streamMessage(userId: string, conversationId: string, content: string) {
    const c = await this.getOwned(userId, conversationId);
    const userMsg = await this.prisma.message.create({
      data: {
        conversationId: c.id,
        role: 'user',
        content,
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

    const history = c.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-12)
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    let full = '';
    try {
      for await (const ev of this.agent.run(userId, history, content)) {
        if (ev.type === 'text_delta') {
          full += ev.delta;
          yield { event: 'text_delta', data: { delta: ev.delta } };
        } else if (ev.type === 'tool_start') {
          yield { event: 'tool_start', data: { name: ev.name } };
        } else if (ev.type === 'tool_end') {
          yield { event: 'tool_end', data: { name: ev.name, ok: ev.ok } };
        } else if (ev.type === 'error') {
          yield { event: 'error', data: { message: ev.message } };
        } else if (ev.type === 'done') {
          full = ev.fullText || full;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      yield { event: 'error', data: { message } };
      full = full || `Error: ${message}`;
    }

    const assistant = await this.prisma.message.create({
      data: {
        conversationId: c.id,
        role: 'assistant',
        content: full || '(empty)',
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
        createdAt: assistant.createdAt.toISOString(),
      },
    };
    yield { event: 'done', data: {} };
  }
}
