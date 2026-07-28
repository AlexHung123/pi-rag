import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { RagflowModule } from '../ragflow/ragflow.module';
import { MediaStorage } from './media-storage';
import { SttClient } from './stt.client';
import { TranscriptionService } from './transcription.service';
import { TranscriptionWorker } from './transcription.worker';

@Module({
  imports: [KnowledgeModule, RagflowModule],
  providers: [MediaStorage, SttClient, TranscriptionService, TranscriptionWorker],
  exports: [MediaStorage, SttClient, TranscriptionService],
})
export class TranscriptionModule {}
