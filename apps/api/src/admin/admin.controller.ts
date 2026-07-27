import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Role } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthPrincipal } from '../auth/auth.types';
import { badRequest } from '../common/errors';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';

@Controller('api/admin')
@UseGuards(AuthGuard, AdminGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  // ── Datasets ────────────────────────────────────────────────────────────

  @Get('datasets')
  listDatasets(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('name') name?: string,
    @Query('owner') owner?: string,
    @Query('chunkMethod') chunkMethod?: string,
  ) {
    return this.admin.listDatasets({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      name,
      owner,
      chunkMethod,
    });
  }

  @Post('datasets/batch-delete')
  batchDeleteDatasets(@Body() body: { ids?: string[] }) {
    return this.admin.batchDeleteDatasets(body.ids || []);
  }

  // ── Documents ───────────────────────────────────────────────────────────

  @Get('datasets/:kbId/documents')
  listDocuments(
    @Param('kbId') kbId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keywords') keywords?: string,
    @Query('status') status?: string,
  ) {
    return this.admin.listDocuments(kbId, {
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      keywords,
      status,
    });
  }

  @Post('datasets/:kbId/documents/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: {
        fileSize: Number(process.env.MAX_UPLOAD_BYTES || 50 * 1024 * 1024),
      },
    }),
  )
  uploadDocument(
    @Param('kbId') kbId: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw badRequest('file is required');
    return this.admin.uploadDocument(kbId, {
      originalname: file.originalname,
      buffer: file.buffer,
      size: file.size,
      mimetype: file.mimetype,
    });
  }

  @Post('datasets/:kbId/documents/parse')
  parseDocuments(
    @Param('kbId') kbId: string,
    @Body() body: { documentIds?: string[] },
  ) {
    return this.admin.parseDocuments(kbId, body.documentIds || []);
  }

  @Post('datasets/:kbId/documents/stop-parse')
  stopParseDocuments(
    @Param('kbId') kbId: string,
    @Body() body: { documentIds?: string[] },
  ) {
    return this.admin.stopParseDocuments(kbId, body.documentIds || []);
  }

  @Post('datasets/:kbId/documents/batch-delete')
  batchDeleteDocuments(
    @Param('kbId') kbId: string,
    @Body() body: { ids?: string[] },
  ) {
    return this.admin.batchDeleteDocuments(kbId, body.ids || []);
  }

  // ── Tasks ───────────────────────────────────────────────────────────────

  @Get('tasks')
  listTasks(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('docName') docName?: string,
    @Query('datasetName') datasetName?: string,
    @Query('owner') owner?: string,
    @Query('status') status?: string,
  ) {
    return this.admin.listTasks({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      docName,
      datasetName,
      owner,
      status,
    });
  }

  @Get('tasks/stats')
  taskStats() {
    return this.admin.taskStats();
  }

  @Post('tasks/batch-parse')
  batchParseTasks(
    @Body()
    body: {
      tasks?: Array<{ knowledgeBaseId: string; documentIds: string[] }>;
    },
  ) {
    return this.admin.batchParseTasks(body.tasks || []);
  }

  @Post('tasks/batch-stop')
  batchStopTasks(
    @Body()
    body: {
      tasks?: Array<{ knowledgeBaseId: string; documentIds: string[] }>;
    },
  ) {
    return this.admin.batchStopTasks(body.tasks || []);
  }

  @Post('tasks/retry-failed')
  retryFailedTasks() {
    return this.admin.retryFailedTasks();
  }

  // ── Users ───────────────────────────────────────────────────────────────

  @Get('users')
  listUsers(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('status') status?: string,
  ) {
    return this.admin.listUsers({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      keyword,
      status,
    });
  }

  @Post('users')
  createUser(
    @Body() body: { username?: string; password?: string; role?: Role },
  ) {
    return this.admin.createUser({
      username: body.username || '',
      password: body.password || '',
      role: body.role,
    });
  }

  @Patch('users/:id/status')
  setUserStatus(
    @CurrentUser() actor: AuthPrincipal,
    @Param('id') id: string,
    @Body() body: { disabled?: boolean },
  ) {
    if (typeof body.disabled !== 'boolean') {
      throw badRequest('disabled boolean is required');
    }
    return this.admin.setUserStatus(actor.userId, id, body.disabled);
  }

  @Patch('users/:id/role')
  setUserRole(
    @CurrentUser() actor: AuthPrincipal,
    @Param('id') id: string,
    @Body() body: { role?: Role },
  ) {
    if (!body.role) throw badRequest('role is required');
    return this.admin.setUserRole(actor.userId, id, body.role);
  }

  @Patch('users/:id/password')
  setUserPassword(
    @Param('id') id: string,
    @Body() body: { password?: string },
  ) {
    return this.admin.setUserPassword(id, body.password || '');
  }

  @Post('users/batch-delete')
  batchDeleteUsers(
    @CurrentUser() actor: AuthPrincipal,
    @Body() body: { ids?: string[] },
  ) {
    return this.admin.batchDeleteUsers(actor.userId, body.ids || []);
  }
}
