import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthPrincipal } from '../auth/auth.types';
import { KnowledgeService } from './knowledge.service';
import {
  AddKnowledgeBaseMemberDto,
  CreateKnowledgeBaseDto,
  UpdateKnowledgeBaseDto,
  UpdateKnowledgeBaseMemberDto,
} from './knowledge.dto';

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

  @Get(':id/members')
  async listMembers(
    @CurrentUser() user: AuthPrincipal,
    @Param('id') id: string,
  ) {
    return this.knowledge.listMembers(user.userId, id);
  }

  @Get(':id/share-candidates')
  async listShareCandidates(
    @CurrentUser() user: AuthPrincipal,
    @Param('id') id: string,
  ) {
    return this.knowledge.listShareCandidates(user.userId, id);
  }

  @Post(':id/members')
  async addMember(
    @CurrentUser() user: AuthPrincipal,
    @Param('id') id: string,
    @Body() body: AddKnowledgeBaseMemberDto,
  ) {
    return this.knowledge.addMember(user.userId, id, body);
  }

  @Patch(':id/members/:userId')
  async updateMember(
    @CurrentUser() user: AuthPrincipal,
    @Param('id') id: string,
    @Param('userId') memberUserId: string,
    @Body() body: UpdateKnowledgeBaseMemberDto,
  ) {
    return this.knowledge.updateMember(user.userId, id, memberUserId, body);
  }

  @Delete(':id/members/:userId')
  async removeMember(
    @CurrentUser() user: AuthPrincipal,
    @Param('id') id: string,
    @Param('userId') memberUserId: string,
  ) {
    return this.knowledge.removeMember(user.userId, id, memberUserId);
  }

  @Get(':id')
  async get(@CurrentUser() user: AuthPrincipal, @Param('id') id: string) {
    return this.knowledge.get(user.userId, id);
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthPrincipal,
    @Param('id') id: string,
    @Body() body: UpdateKnowledgeBaseDto,
  ) {
    return this.knowledge.update(user.userId, id, body);
  }

  @Delete(':id')
  async remove(@CurrentUser() user: AuthPrincipal, @Param('id') id: string) {
    return this.knowledge.remove(user.userId, id);
  }
}
