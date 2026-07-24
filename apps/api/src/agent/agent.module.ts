import { Module } from '@nestjs/common';
import { AgentService } from './agent.service';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { DocumentsModule } from '../documents/documents.module';

@Module({
  imports: [KnowledgeModule, DocumentsModule],
  providers: [AgentService],
  exports: [AgentService],
})
export class AgentModule {}
