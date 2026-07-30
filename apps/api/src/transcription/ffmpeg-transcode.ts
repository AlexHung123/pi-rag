import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { Logger } from '@nestjs/common';

const execFileAsync = promisify(execFile);
const logger = new Logger('FfmpegTranscode');

/**
 * Convert media to 16kHz mono PCM WAV for SenseVoice / FunASR.
 *
 * Equivalent to:
 *   ffmpeg -i input.mp4 -ar 16000 -ac 1 -c:a pcm_s16le meeting.wav
 *
 * Modes:
 * - Local (default): run `ffmpeg` on the API host (`STT_FFMPEG_BIN`)
 * - SSH remote: set `STT_FFMPEG_SSH=user@192.168.1.11` to run on STT box
 *   (requires passwordless SSH + ffmpeg on the remote host)
 */
export async function transcodeToWav16kMono(
  inputAbsolutePath: string,
  outputAbsolutePath: string,
): Promise<string> {
  if (!fs.existsSync(inputAbsolutePath)) {
    throw new Error(`transcode input not found: ${inputAbsolutePath}`);
  }

  const outDir = path.dirname(outputAbsolutePath);
  fs.mkdirSync(outDir, { recursive: true });

  const sshTarget = (process.env.STT_FFMPEG_SSH || '').trim();
  if (sshTarget) {
    return transcodeViaSsh(sshTarget, inputAbsolutePath, outputAbsolutePath);
  }

  return transcodeLocal(inputAbsolutePath, outputAbsolutePath);
}

function ffmpegBin(): string {
  return (process.env.STT_FFMPEG_BIN || 'ffmpeg').trim() || 'ffmpeg';
}

function ffmpegTimeoutMs(): number {
  return Math.max(30_000, Number(process.env.STT_FFMPEG_TIMEOUT_MS || 3_600_000));
}

async function transcodeLocal(input: string, output: string): Promise<string> {
  const bin = ffmpegBin();
  // Overwrite output; 16 kHz mono s16le PCM WAV
  const args = [
    '-y',
    '-i',
    input,
    '-ar',
    '16000',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    output,
  ];
  logger.log(`ffmpeg local: ${bin} ${args.join(' ')}`);
  try {
    await execFileAsync(bin, args, {
      timeout: ffmpegTimeoutMs(),
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`ffmpeg transcode failed: ${msg}`);
  }
  if (!fs.existsSync(output) || fs.statSync(output).size <= 0) {
    throw new Error('ffmpeg produced empty or missing wav');
  }
  return output;
}

/**
 * scp input → remote /tmp, run ffmpeg, scp wav back.
 * Remote path uses basename only under /tmp/pi-rag-stt/.
 */
async function transcodeViaSsh(
  sshTarget: string,
  input: string,
  output: string,
): Promise<string> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const remoteDir = `/tmp/pi-rag-stt/${id}`;
  const baseIn = path.basename(input);
  const remoteIn = `${remoteDir}/${baseIn}`;
  const remoteOut = `${remoteDir}/meeting.wav`;
  const sshOpts = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];

  logger.log(`ffmpeg via SSH ${sshTarget}: ${baseIn} → meeting.wav`);

  try {
    await execFileAsync('ssh', [...sshOpts, sshTarget, `mkdir -p ${remoteDir}`], {
      timeout: 30_000,
    });
    await execFileAsync('scp', [...sshOpts, input, `${sshTarget}:${remoteIn}`], {
      timeout: ffmpegTimeoutMs(),
    });
    const remoteCmd = [
      `${ffmpegBin()} -y -i ${shellQuote(remoteIn)} -ar 16000 -ac 1 -c:a pcm_s16le ${shellQuote(remoteOut)}`,
      `&& test -s ${shellQuote(remoteOut)}`,
    ].join(' ');
    await execFileAsync('ssh', [...sshOpts, sshTarget, remoteCmd], {
      timeout: ffmpegTimeoutMs(),
      maxBuffer: 2 * 1024 * 1024,
    });
    await execFileAsync('scp', [...sshOpts, `${sshTarget}:${remoteOut}`, output], {
      timeout: ffmpegTimeoutMs(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `remote ffmpeg (STT_FFMPEG_SSH=${sshTarget}) failed: ${msg}. ` +
        `Ensure passwordless SSH and ffmpeg on the remote host.`,
    );
  } finally {
    // Best-effort remote cleanup
    try {
      await execFileAsync(
        'ssh',
        [...sshOpts, sshTarget, `rm -rf ${shellQuote(remoteDir)}`],
        { timeout: 15_000 },
      );
    } catch {
      // ignore
    }
  }

  if (!fs.existsSync(output) || fs.statSync(output).size <= 0) {
    throw new Error('remote ffmpeg produced empty or missing wav');
  }
  return output;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
