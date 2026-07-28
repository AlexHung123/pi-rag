import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthPrincipal } from '../auth/auth.types';
import { DocumentsService } from './documents.service';
import { badRequest } from '../common/errors';

@Controller('api/knowledge-bases/:kbId/documents')
@UseGuards(AuthGuard)
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  async list(@CurrentUser() user: AuthPrincipal, @Param('kbId') kbId: string) {
    return { items: await this.documents.list(user.userId, kbId) };
  }

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES || 50 * 1024 * 1024) },
    }),
  )
  async upload(
    @CurrentUser() user: AuthPrincipal,
    @Param('kbId') kbId: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw badRequest('file is required');
    return this.documents.upload(user.userId, kbId, {
      originalname: file.originalname,
      buffer: file.buffer,
      size: file.size,
      mimetype: file.mimetype,
    });
  }

  /** Batch parse — static path must be registered before :docId routes. */
  @Post('batch-parse')
  async batchParse(
    @CurrentUser() user: AuthPrincipal,
    @Param('kbId') kbId: string,
    @Body() body: { documentIds?: string[] },
  ) {
    return this.documents.batchParse(user.userId, kbId, body?.documentIds || []);
  }

  /** Batch stop parse — static path must be registered before :docId routes. */
  @Post('batch-stop-parse')
  async batchStopParse(
    @CurrentUser() user: AuthPrincipal,
    @Param('kbId') kbId: string,
    @Body() body: { documentIds?: string[] },
  ) {
    return this.documents.batchStopParse(user.userId, kbId, body?.documentIds || []);
  }

  @Get(':docId')
  async get(
    @CurrentUser() user: AuthPrincipal,
    @Param('kbId') kbId: string,
    @Param('docId') docId: string,
  ) {
    return this.documents.get(user.userId, kbId, docId);
  }

  @Post(':docId/parse')
  async parse(
    @CurrentUser() user: AuthPrincipal,
    @Param('kbId') kbId: string,
    @Param('docId') docId: string,
  ) {
    return this.documents.parse(user.userId, kbId, docId);
  }

  /** Stop parsing a document (RAGFlow DELETE .../chunks with document_ids). */
  @Post(':docId/stop-parse')
  async stopParse(
    @CurrentUser() user: AuthPrincipal,
    @Param('kbId') kbId: string,
    @Param('docId') docId: string,
  ) {
    return this.documents.stopParse(user.userId, kbId, docId);
  }

  @Get(':docId/chunks')
  async chunks(
    @CurrentUser() user: AuthPrincipal,
    @Param('kbId') kbId: string,
    @Param('docId') docId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keywords') keywords?: string,
  ) {
    return this.documents.chunks(user.userId, kbId, docId, {
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
      keywords,
    });
  }

  @Get(':docId/preview')
  async preview(
    @CurrentUser() user: AuthPrincipal,
    @Param('kbId') kbId: string,
    @Param('docId') docId: string,
  ) {
    return this.documents.preview(user.userId, kbId, docId);
  }

  /** Proxy original file from RAGFlow for inline preview (PDF/text/image/Office). */
  @Get(':docId/file')
  async file(
    @CurrentUser() user: AuthPrincipal,
    @Param('kbId') kbId: string,
    @Param('docId') docId: string,
  ): Promise<StreamableFile> {
    const file = await this.documents.downloadFile(user.userId, kbId, docId);
    const safeName = file.filename.replace(/[\\/"]/g, '_');
    return new StreamableFile(file.buffer, {
      type: file.contentType,
      disposition: `inline; filename="${safeName}"`,
      length: file.buffer.length,
    });
  }

  @Delete(':docId')
  async remove(
    @CurrentUser() user: AuthPrincipal,
    @Param('kbId') kbId: string,
    @Param('docId') docId: string,
  ) {
    return this.documents.remove(user.userId, kbId, docId);
  }
}
