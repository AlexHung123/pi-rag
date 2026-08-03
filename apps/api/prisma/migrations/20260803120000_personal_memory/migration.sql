-- CreateEnum
CREATE TYPE "MemoryCategory" AS ENUM ('preference', 'fact', 'project', 'other');

-- CreateEnum
CREATE TYPE "MemorySource" AS ENUM ('manual', 'extracted');

-- CreateEnum
CREATE TYPE "MemoryStatus" AS ENUM ('active', 'archived');

-- CreateTable
CREATE TABLE "user_profiles" (
    "user_id" UUID NOT NULL,
    "display_name" TEXT,
    "language" TEXT,
    "response_style" TEXT,
    "bio" TEXT NOT NULL DEFAULT '',
    "prefs" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "memory_items" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "category" "MemoryCategory" NOT NULL DEFAULT 'other',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "importance" INTEGER NOT NULL DEFAULT 3,
    "source" "MemorySource" NOT NULL DEFAULT 'manual',
    "status" "MemoryStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memory_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memory_items_user_id_status_pinned_importance_updated_at_idx" ON "memory_items"("user_id", "status", "pinned", "importance", "updated_at");

-- CreateIndex
CREATE INDEX "memory_items_user_id_updated_at_idx" ON "memory_items"("user_id", "updated_at");

-- AddForeignKey
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
