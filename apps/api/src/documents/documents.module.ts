import { Module } from '@nestjs/common';
import { DocumentsService } from './documents.service';
import { DocumentsController } from './documents.controller';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule, KnowledgeModule],
  providers: [DocumentsService],
  controllers: [DocumentsController],
  exports: [DocumentsService],
})
export class DocumentsModule {}
