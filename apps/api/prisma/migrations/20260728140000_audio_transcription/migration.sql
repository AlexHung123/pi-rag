-- CreateEnum
CREATE TYPE "DocumentSourceType" AS ENUM ('file', 'audio');

-- CreateEnum
CREATE TYPE "TranscriptionJobStatus" AS ENUM ('queued', 'running', 'done', 'failed', 'cancelled');

-- AlterTable: nullable ragflow id + audio source fields
ALTER TABLE "documents" ALTER COLUMN "ragflow_document_id" DROP NOT NULL;

ALTER TABLE "documents" ADD COLUMN "source_type" "DocumentSourceType" NOT NULL DEFAULT 'file';
ALTER TABLE "documents" ADD COLUMN "media_path" TEXT;
ALTER TABLE "documents" ADD COLUMN "media_content_type" TEXT;
ALTER TABLE "documents" ADD COLUMN "transcript_language" TEXT;
ALTER TABLE "documents" ADD COLUMN "duration_seconds" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "transcription_jobs" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "knowledge_base_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "status" "TranscriptionJobStatus" NOT NULL DEFAULT 'queued',
    "stage" TEXT NOT NULL DEFAULT 'queued',
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "progress_msg" TEXT,
    "language" TEXT,
    "stt_model" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "locked_by" TEXT,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transcription_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transcription_jobs_status_created_at_idx" ON "transcription_jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "transcription_jobs_document_id_idx" ON "transcription_jobs"("document_id");

-- CreateIndex
CREATE INDEX "transcription_jobs_owner_user_id_created_at_idx" ON "transcription_jobs"("owner_user_id", "created_at");

-- AddForeignKey
ALTER TABLE "transcription_jobs" ADD CONSTRAINT "transcription_jobs_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
