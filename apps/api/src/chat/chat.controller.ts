import {
  Body,
  Controller,
  Delete,
  Get,
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
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    try {
      for await (const frame of this.chat.streamMessage(
        user.userId,
        id,
        body.content,
      )) {
        res.write(`event: ${frame.event}\n`);
        res.write(`data: ${JSON.stringify(frame.data)}\n\n`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ message })}\n\n`);
    }
    res.end();
  }
}
