import { IsObject, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateKnowledgeBaseDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  chunkMethod?: string;

  @IsOptional()
  @IsObject()
  parserConfig?: Record<string, unknown>;
}
