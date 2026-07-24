import { Global, Module } from '@nestjs/common';
import { RagflowService } from './ragflow.service';

@Global()
@Module({
  providers: [RagflowService],
  exports: [RagflowService],
})
export class RagflowModule {}
