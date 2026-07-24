import { IsOptional, IsString, MinLength } from 'class-validator';

export class CreateConversationDto {
  @IsOptional()
  @IsString()
  title?: string;
}

export class PostMessageDto {
  @IsString()
  @MinLength(1)
  content!: string;
}
