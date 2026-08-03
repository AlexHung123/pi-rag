import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import {
  getDefaultModelId,
  resolveModelAllowlist,
} from '../agent/pi-model';

@Controller('api/models')
@UseGuards(AuthGuard)
export class ModelsController {
  @Get()
  list() {
    const defaultModelId = getDefaultModelId();
    // key = id (sent as modelId), value = name (UI label)
    const models = resolveModelAllowlist().map(({ id, name }) => ({
      id,
      name,
    }));
    return { defaultModelId, models };
  }
}
