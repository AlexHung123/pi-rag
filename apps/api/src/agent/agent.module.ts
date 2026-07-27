import { Module } from '@nestjs/common';
import { AgentService } from './agent.service';
import { AgentSessionPool } from './agent-session.pool';
import { KnowledgeModule } from '../knowledge/knowledge.module';

@Module({
  imports: [KnowledgeModule],
  providers: [AgentSessionPool, AgentService],
  exports: [AgentService, AgentSessionPool],
})
export class AgentModule {}
