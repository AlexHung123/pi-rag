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
import { diskStorage } from 'multer';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthPrincipal } from '../auth/auth.types';
import { DocumentsService } from './documents.service';
import { badRequest } from '../common/errors';
import { MediaStorage } from '../transcription/media-storage';

/** Max of document + audio caps so multer does not reject large audio early. */
function multerMaxBytes(): number {
  const docMax = Number(process.env.MAX_UPLOAD_BYTES || 50 * 1024 * 1024);
  const audioMax = Number(process.env.MAX_AUDIO_UPLOAD_BYTES || 524288000);
  return Math.max(docMax, audioMax);
}

function uploadDiskStorage() {
  // Resolve MEDIA_ROOT the same way MediaStorage does (lazy at request time).
  const media = new MediaStorage();
  return diskStorage({
    destination: (_req, _file, cb) => {
      try {
        cb(null, media.incomingDir());
      } catch (e) {
        cb(e as Error, '');
      }
    },
    filename: (_req, file, cb) => {
      cb(null, media.makeIncomingFilename(file.originalname || 'upload.bin'));
    },
  });
}

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
      storage: uploadDiskStorage(),
      limits: { fileSize: multerMaxBytes() },
    }),
  )
  async upload(
    @CurrentUser() user: AuthPrincipal,
    @Param('kbId') kbId: string,
    @UploadedFile() file?: Express.Multer.File,
    @Body('language') language?: string,
  ) {
    if (!file) throw badRequest('file is required');
    // Disk storage: path is set; buffer may be empty
    return this.documents.upload(
      user.userId,
      kbId,
      {
        originalname: file.originalname,
        size: file.size,
        mimetype: file.mimetype,
        path: file.path,
        // memory fallback if someone reconfigures storage
        buffer: file.buffer,
      },
      { language: language?.trim() || null },
    );
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

  @Post(':docId/cancel-transcription')
  async cancelTranscription(
    @CurrentUser() user: AuthPrincipal,
    @Param('kbId') kbId: string,
    @Param('docId') docId: string,
  ) {
    return this.documents.cancelTranscription(user.userId, kbId, docId);
  }

  @Post(':docId/retry-transcription')
  async retryTranscription(
    @CurrentUser() user: AuthPrincipal,
    @Param('kbId') kbId: string,
    @Param('docId') docId: string,
  ) {
    return this.documents.retryTranscription(user.userId, kbId, docId);
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
