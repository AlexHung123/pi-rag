import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { AgentModule } from '../agent/agent.module';
import { AuthModule } from '../auth/auth.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { FastRagService } from '../rag/fast-rag.service';

@Module({
  imports: [AuthModule, AgentModule, KnowledgeModule],
  providers: [ChatService, FastRagService],
  controllers: [ChatController],
})
export class ChatModule {}
