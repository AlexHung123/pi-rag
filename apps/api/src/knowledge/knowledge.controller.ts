import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthPrincipal } from '../auth/auth.types';
import { KnowledgeService } from './knowledge.service';
import { CreateKnowledgeBaseDto } from './knowledge.dto';

@Controller('api/knowledge-bases')
@UseGuards(AuthGuard)
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get()
  async list(@CurrentUser() user: AuthPrincipal) {
    return { items: await this.knowledge.list(user.userId) };
  }

  @Post()
  async create(
    @CurrentUser() user: AuthPrincipal,
    @Body() body: CreateKnowledgeBaseDto,
  ) {
    return this.knowledge.create(user.userId, body);
  }

  @Get(':id')
  async get(@CurrentUser() user: AuthPrincipal, @Param('id') id: string) {
    return this.knowledge.get(user.userId, id);
  }

  @Delete(':id')
  async remove(@CurrentUser() user: AuthPrincipal, @Param('id') id: string) {
    return this.knowledge.remove(user.userId, id);
  }
}
