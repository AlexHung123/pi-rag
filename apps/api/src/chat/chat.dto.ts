import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
} from 'class-validator';

export class CreateConversationDto {
  @IsOptional()
  @IsString()
  title?: string;
}

export class PostMessageDto {
  @IsString()
  @MinLength(1)
  content!: string;

  /** Optional multi-select knowledge base IDs for scoped retrieval. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  knowledgeBaseIds?: string[];
}
