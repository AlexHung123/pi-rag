import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AgentModule } from '../agent/agent.module';
import { TranscriptionModule } from '../transcription/transcription.module';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';

@Module({
  imports: [AuthModule, AgentModule, TranscriptionModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
})
export class AdminModule {}
