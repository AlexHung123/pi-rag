import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { ModelsController } from '../models/models.controller';
import { AgentModule } from '../agent/agent.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule, AgentModule],
  providers: [ChatService],
  controllers: [ChatController, ModelsController],
})
export class ChatModule {}
