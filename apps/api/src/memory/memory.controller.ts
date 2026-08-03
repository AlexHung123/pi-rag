import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthPrincipal } from '../auth/auth.types';
import { MemoryService } from './memory.service';
import {
  CreateMemoryItemDto,
  UpdateMemoryItemDto,
  UpdateProfileDto,
} from './memory.dto';

@Controller('api/me')
@UseGuards(AuthGuard)
export class MemoryController {
  constructor(private readonly memory: MemoryService) {}

  @Get('profile')
  getProfile(@CurrentUser() user: AuthPrincipal) {
    return this.memory.getOrCreateProfile(user.userId);
  }

  @Put('profile')
  putProfile(
    @CurrentUser() user: AuthPrincipal,
    @Body() body: UpdateProfileDto,
  ) {
    return this.memory.updateProfile(user.userId, body);
  }

  @Get('memories')
  listMemories(
    @CurrentUser() user: AuthPrincipal,
    @Query('status') status?: 'active' | 'archived',
    @Query('category') category?: string,
  ) {
    return this.memory
      .listItems(user.userId, { status, category })
      .then((items) => ({ items }));
  }

  @Post('memories')
  createMemory(
    @CurrentUser() user: AuthPrincipal,
    @Body() body: CreateMemoryItemDto,
  ) {
    return this.memory.createItem(user.userId, body);
  }

  @Patch('memories/:id')
  updateMemory(
    @CurrentUser() user: AuthPrincipal,
    @Param('id') id: string,
    @Body() body: UpdateMemoryItemDto,
  ) {
    return this.memory.updateItem(user.userId, id, body);
  }

  @Delete('memories/:id')
  deleteMemory(@CurrentUser() user: AuthPrincipal, @Param('id') id: string) {
    return this.memory.deleteItem(user.userId, id);
  }
}
