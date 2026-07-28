import { execFile } from 'child_process';
import { promisify } from 'util';
import { Logger } from '@nestjs/common';

const execFileAsync = promisify(execFile);
const logger = new Logger('DurationProbe');

/**
 * Best-effort duration probe via system `ffprobe` when available.
 * Returns null when ffprobe is missing or probe fails (never throws).
 */
export async function probeDurationSeconds(
  absolutePath: string,
): Promise<number | null> {
  if (!absolutePath) return null;
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        absolutePath,
      ],
      { timeout: 30_000, maxBuffer: 64 * 1024 },
    );
    const n = Number(String(stdout).trim());
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  } catch (e) {
    logger.debug?.(
      `ffprobe unavailable or failed: ${e instanceof Error ? e.message : e}`,
    );
    return null;
  }
}
