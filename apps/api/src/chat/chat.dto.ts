import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { CHAT_MESSAGE_MAX_CHARS } from './chat.limits';

export class CreateConversationDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;
}

export class PostMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(CHAT_MESSAGE_MAX_CHARS)
  content!: string;

  /** Optional multi-select knowledge base IDs for scoped retrieval. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  knowledgeBaseIds?: string[];

  /**
   * Optional multi-select document IDs (portal UUIDs) under the selected KBs.
   * Empty/omit = search entire selected knowledge bases.
   * Server maps to RAGFlow retrieval `document_ids`.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  documentIds?: string[];

  /**
   * Optional per-message model id (must be on server OPENAI_MODELS allowlist).
   * Omit to use OPENAI_MODEL default.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  modelId?: string;
}
