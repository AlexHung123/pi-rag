import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { DocumentsModule } from './documents/documents.module';
import { ChatModule } from './chat/chat.module';
import { RagflowModule } from './ragflow/ragflow.module';
import { AgentModule } from './agent/agent.module';
import { AdminModule } from './admin/admin.module';
import { TranscriptionModule } from './transcription/transcription.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    RagflowModule,
    KnowledgeModule,
    TranscriptionModule,
    DocumentsModule,
    AgentModule,
    ChatModule,
    AdminModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
