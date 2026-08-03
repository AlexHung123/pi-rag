import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthPrincipal } from '../auth/auth.types';
import { ChatService } from './chat.service';
import { CreateConversationDto, PostMessageDto } from './chat.dto';

@Controller('api/conversations')
@UseGuards(AuthGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get()
  async list(@CurrentUser() user: AuthPrincipal) {
    return { items: await this.chat.list(user.userId) };
  }

  @Post()
  async create(
    @CurrentUser() user: AuthPrincipal,
    @Body() body: CreateConversationDto,
  ) {
    return this.chat.create(user.userId, body.title);
  }

  @Get(':id')
  async get(@CurrentUser() user: AuthPrincipal, @Param('id') id: string) {
    return this.chat.get(user.userId, id);
  }

  @Delete(':id')
  async remove(@CurrentUser() user: AuthPrincipal, @Param('id') id: string) {
    return this.chat.remove(user.userId, id);
  }

  @Post(':id/messages')
  async postMessage(
    @CurrentUser() user: AuthPrincipal,
    @Param('id') id: string,
    @Body() body: PostMessageDto,
    @Res() res: Response,
  ) {
    // Validate allowlisted model before opening SSE (so clients get HTTP 400).
    // With @Res(), write the error ourselves so Nest does not leave a hanging stream.
    let resolvedModelId: string;
    try {
      resolvedModelId = this.chat.resolveModelId(body.modelId);
    } catch (err) {
      if (err instanceof HttpException) {
        const status = err.getStatus();
        const payload = err.getResponse();
        res
          .status(status)
          .json(
            typeof payload === 'string'
              ? { statusCode: status, message: payload }
              : payload,
          );
        return;
      }
      throw err;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // Client Stop / tab close → abort in-flight agent run.
    // Only treat as abort when the response was not finished cleanly
    // (normal res.end() also emits "close").
    const abort = new AbortController();
    const onClientGone = () => {
      if (!res.writableFinished && !abort.signal.aborted) {
        abort.abort();
      }
    };
    res.on('close', onClientGone);

    try {
      // Always drain the generator so ChatService can persist a partial reply
      // after abort; only skip writing once the client is gone.
      for await (const frame of this.chat.streamMessage(
        user.userId,
        id,
        body.content,
        body.knowledgeBaseIds,
        abort.signal,
        resolvedModelId,
      )) {
        if (abort.signal.aborted || res.writableEnded || res.destroyed) {
          continue;
        }
        res.write(`event: ${frame.event}\n`);
        res.write(`data: ${JSON.stringify(frame.data)}\n\n`);
      }
    } catch (err) {
      if (!abort.signal.aborted && !res.writableEnded && !res.destroyed) {
        const message = err instanceof Error ? err.message : String(err);
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ message })}\n\n`);
      }
    } finally {
      res.off('close', onClientGone);
    }
    if (!res.writableEnded) {
      res.end();
    }
  }
}
