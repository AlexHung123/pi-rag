import { describe, expect, it, vi } from 'vitest';
import {
  assertWithinStorageQuota,
  storageLockKeys,
} from '../src/common/storage-quota';
import type { PrismaService } from '../src/prisma/prisma.service';
import { HttpException } from '@nestjs/common';

describe('assertWithinStorageQuota', () => {
  it('allows upload under quota', async () => {
    const prisma = {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          storageQuotaBytes: BigInt(1000),
        }),
      },
      document: {
        aggregate: vi.fn().mockResolvedValue({
          _sum: { sizeBytes: BigInt(200) },
        }),
      },
    } as unknown as PrismaService;

    const usage = await assertWithinStorageQuota(prisma, 'u1', 100);
    expect(usage.usedBytes).toBe(200);
    expect(usage.remainingBytes).toBe(800);
  });

  it('rejects upload over quota', async () => {
    const prisma = {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          storageQuotaBytes: BigInt(1000),
        }),
      },
      document: {
        aggregate: vi.fn().mockResolvedValue({
          _sum: { sizeBytes: BigInt(900) },
        }),
      },
    } as unknown as PrismaService;

    await expect(assertWithinStorageQuota(prisma, 'u1', 200)).rejects.toBeInstanceOf(
      HttpException,
    );
  });
});

describe('storageLockKeys', () => {
  it('returns stable keys for the same userId', () => {
    const a = storageLockKeys('user-abc');
    const b = storageLockKeys('user-abc');
    expect(a).toEqual(b);
    expect(a[0]).toBe(0x73746f72);
  });

  it('returns different key2 for different users', () => {
    const a = storageLockKeys('user-a');
    const b = storageLockKeys('user-b');
    expect(a[1]).not.toBe(b[1]);
  });
});
