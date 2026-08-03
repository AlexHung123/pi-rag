import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  displayName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  language?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  responseStyle?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @IsOptional()
  @IsObject()
  prefs?: Record<string, unknown>;
}

export class CreateMemoryItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  content!: string;

  @IsOptional()
  @IsIn(['preference', 'fact', 'project', 'other'])
  category?: 'preference' | 'fact' | 'project' | 'other';

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  importance?: number;
}

export class UpdateMemoryItemDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  content?: string;

  @IsOptional()
  @IsIn(['preference', 'fact', 'project', 'other'])
  category?: 'preference' | 'fact' | 'project' | 'other';

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  importance?: number;

  @IsOptional()
  @IsIn(['active', 'archived'])
  status?: 'active' | 'archived';
}
