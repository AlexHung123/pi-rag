import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { badRequest, notFound } from './errors';

/** Default total storage per user: 5 GiB */
export const DEFAULT_STORAGE_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * Map userId to two int32 keys for pg_advisory_lock (stable, non-cryptographic).
 * Namespace key1 keeps locks distinct from other app advisory uses.
 */
export function storageLockKeys(userId: string): [number, number] {
  const hash = createHash('sha256').update(`storage-quota:${userId}`).digest();
  const key1 = 0x73746f72; // 'stor' as namespace
  const key2 = hash.readInt32BE(0);
  return [key1, key2];
}

/**
 * Serialize check+upload+insert for one user so concurrent uploads cannot
 * all pass quota against a stale "used" sum (TOCTOU).
 *
 * Uses transaction-scoped advisory locks (pg_advisory_xact_lock) so lock + work
 * share one pooled connection and the lock is released when the transaction
 * ends. Session-level pg_advisory_lock is unsafe with Prisma's pool: lock and
 * unlock may run on different connections and leave a permanent hang.
 *
 * Cast to integer: Postgres has (int,int) and (bigint) overloads, not (bigint,bigint).
 */
export async function withUserStorageLock<T>(
  prisma: PrismaService,
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const [key1, key2] = storageLockKeys(userId);
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
        key1,
        key2,
      );
      // fn uses the outer prisma client for writes; mutual exclusion is still
      // enforced while this transaction holds the xact lock on its connection.
      return fn();
    },
    {
      // Wait up to 60s to acquire lock if another upload is in progress
      maxWait: 60_000,
      // Large audio may take a while under the lock (disk + enqueue only)
      timeout: 120_000,
    },
  );
}

export function defaultStorageQuotaBytes(): number {
  const raw = Number(process.env.DEFAULT_STORAGE_QUOTA_BYTES);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return DEFAULT_STORAGE_QUOTA_BYTES;
}

export function formatStorageBytes(n: number | bigint): string {
  const v = typeof n === 'bigint' ? Number(n) : n;
  if (!Number.isFinite(v) || v < 0) return '0 B';
  if (v < 1024) return `${Math.round(v)} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
  return `${(v / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export type StorageUsage = {
  usedBytes: number;
  quotaBytes: number;
  remainingBytes: number;
  usageRatio: number;
};

export async function getUserStorageUsage(
  prisma: PrismaService,
  userId: string,
): Promise<StorageUsage> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { storageQuotaBytes: true },
  });
  if (!user) {
    throw notFound('user not found');
  }
  const agg = await prisma.document.aggregate({
    where: { ownerUserId: userId },
    _sum: { sizeBytes: true },
  });
  const usedBytes = Number(agg._sum.sizeBytes ?? 0n);
  const quotaBytes = Number(user.storageQuotaBytes);
  const remainingBytes = Math.max(0, quotaBytes - usedBytes);
  const usageRatio = quotaBytes > 0 ? usedBytes / quotaBytes : usedBytes > 0 ? 1 : 0;
  return {
    usedBytes,
    quotaBytes,
    remainingBytes,
    usageRatio,
  };
}

/**
 * Ensure adding `additionalBytes` would not exceed the user's total storage quota.
 * Call before proxying to RAGFlow.
 */
export async function assertWithinStorageQuota(
  prisma: PrismaService,
  userId: string,
  additionalBytes: number,
): Promise<StorageUsage> {
  const usage = await getUserStorageUsage(prisma, userId);
  const need = Math.max(0, Number(additionalBytes) || 0);
  if (usage.usedBytes + need > usage.quotaBytes) {
    throw badRequest(
      `Storage quota exceeded. Used ${formatStorageBytes(usage.usedBytes)} / ${formatStorageBytes(usage.quotaBytes)}. ` +
        `This file needs ${formatStorageBytes(need)} (${formatStorageBytes(usage.remainingBytes)} free). ` +
        `Delete documents or ask an admin to raise your quota.`,
    );
  }
  return usage;
}

export function parseQuotaBytesInput(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'string' ? Number(value) : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw badRequest('storageQuotaBytes must be a non-negative number');
  }
  // Cap at 1 PiB to avoid accidental absurd values
  const max = 1024 * 1024 * 1024 * 1024 * 1024;
  if (n > max) throw badRequest('storageQuotaBytes is too large');
  return Math.floor(n);
}
