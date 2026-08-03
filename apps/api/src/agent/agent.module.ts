import { Module } from '@nestjs/common';
import { AgentService } from './agent.service';
import { AgentSessionPool } from './agent-session.pool';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { MemoryModule } from '../memory/memory.module';

@Module({
  imports: [KnowledgeModule, MemoryModule],
  providers: [AgentSessionPool, AgentService],
  exports: [AgentService, AgentSessionPool],
})
export class AgentModule {}
