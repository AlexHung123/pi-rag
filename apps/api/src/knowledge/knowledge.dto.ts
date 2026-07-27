import { IsIn, IsObject, IsOptional, IsString, MinLength } from 'class-validator';

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

  /** private = owner only; public = any authenticated user can read/use. Default private. */
  @IsOptional()
  @IsIn(['private', 'public'])
  visibility?: 'private' | 'public';
}

export class UpdateKnowledgeBaseDto {
  @IsOptional()
  @IsIn(['private', 'public'])
  visibility?: 'private' | 'public';
}

export class AddKnowledgeBaseMemberDto {
  /** Username of the user to share with (case-insensitive match). */
  @IsString()
  @MinLength(1)
  username!: string;

  /** viewer = read/use; editor = also upload/parse/delete docs. Default viewer. */
  @IsOptional()
  @IsIn(['viewer', 'editor'])
  role?: 'viewer' | 'editor';
}

export class UpdateKnowledgeBaseMemberDto {
  @IsIn(['viewer', 'editor'])
  role!: 'viewer' | 'editor';
}
