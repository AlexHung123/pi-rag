import * as fs from 'fs';
import * as path from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';

@Injectable()
export class MediaStorage {
  private readonly logger = new Logger(MediaStorage.name);

  /** Absolute MEDIA_ROOT (default: <cwd>/data/media). */
  root(): string {
    const configured = (process.env.MEDIA_ROOT || 'data/media').trim();
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(process.cwd(), configured);
  }

  /** Incoming multer disk dir (under MEDIA_ROOT). */
  incomingDir(): string {
    const abs = path.join(this.root(), '_incoming');
    fs.mkdirSync(abs, { recursive: true });
    return abs;
  }

  /** Resolve a relative path under MEDIA_ROOT; rejects absolute / traversal. */
  resolveSafe(relativePath: string): string {
    const rel = (relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || rel.includes('..') || path.isAbsolute(relativePath)) {
      throw new Error('invalid media path');
    }
    const abs = path.resolve(this.root(), rel);
    const root = this.root() + path.sep;
    if (abs !== this.root() && !abs.startsWith(root)) {
      throw new Error('media path escapes MEDIA_ROOT');
    }
    return abs;
  }

  /** Relative dir: {userId}/{documentId} */
  docRelativeDir(userId: string, documentId: string): string {
    this.assertUuid(userId, 'userId');
    this.assertUuid(documentId, 'documentId');
    return `${userId}/${documentId}`;
  }

  ensureDocDir(userId: string, documentId: string): string {
    const rel = this.docRelativeDir(userId, documentId);
    const abs = this.resolveSafe(rel);
    fs.mkdirSync(abs, { recursive: true });
    return abs;
  }

  sourceRelativePath(userId: string, documentId: string, ext: string): string {
    const safeExt = (ext || 'bin').replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'bin';
    return `${this.docRelativeDir(userId, documentId)}/source.${safeExt}`;
  }

  transcriptRelativePath(userId: string, documentId: string): string {
    return `${this.docRelativeDir(userId, documentId)}/transcript.md`;
  }

  sourcePath(userId: string, documentId: string, ext: string): string {
    return this.resolveSafe(this.sourceRelativePath(userId, documentId, ext));
  }

  transcriptPath(userId: string, documentId: string): string {
    return this.resolveSafe(this.transcriptRelativePath(userId, documentId));
  }

  writeSourceAudio(
    userId: string,
    documentId: string,
    ext: string,
    data: Buffer,
  ): { relativePath: string; absolutePath: string } {
    this.ensureDocDir(userId, documentId);
    const relativePath = this.sourceRelativePath(userId, documentId, ext);
    const absolutePath = this.resolveSafe(relativePath);
    fs.writeFileSync(absolutePath, data);
    return { relativePath, absolutePath };
  }

  /**
   * Move an uploaded temp file into the document's source path (no full buffer copy).
   * Falls back to copy+unlink when rename crosses devices.
   */
  placeSourceFromTemp(
    userId: string,
    documentId: string,
    ext: string,
    tempAbsolutePath: string,
  ): { relativePath: string; absolutePath: string } {
    this.ensureDocDir(userId, documentId);
    const relativePath = this.sourceRelativePath(userId, documentId, ext);
    const absolutePath = this.resolveSafe(relativePath);
    this.moveFile(tempAbsolutePath, absolutePath);
    return { relativePath, absolutePath };
  }

  writeTranscript(
    userId: string,
    documentId: string,
    markdown: string,
  ): { relativePath: string; absolutePath: string } {
    this.ensureDocDir(userId, documentId);
    const relativePath = this.transcriptRelativePath(userId, documentId);
    const absolutePath = this.resolveSafe(relativePath);
    fs.writeFileSync(absolutePath, markdown, 'utf8');
    return { relativePath, absolutePath };
  }

  readTranscriptIfExists(userId: string, documentId: string): string | null {
    try {
      const abs = this.transcriptPath(userId, documentId);
      if (!fs.existsSync(abs)) return null;
      return fs.readFileSync(abs, 'utf8');
    } catch {
      return null;
    }
  }

  hasTranscript(userId: string, documentId: string): boolean {
    try {
      return fs.existsSync(this.transcriptPath(userId, documentId));
    } catch {
      return false;
    }
  }

  absoluteFromRelative(relativePath: string): string {
    return this.resolveSafe(relativePath);
  }

  existsRelative(relativePath: string): boolean {
    try {
      return fs.existsSync(this.resolveSafe(relativePath));
    } catch {
      return false;
    }
  }

  /** Best-effort delete of a single temp upload file. */
  removeTempFile(absolutePath: string | undefined | null): void {
    if (!absolutePath) return;
    try {
      if (fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
    } catch (e) {
      this.logger.warn(
        `removeTempFile failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Best-effort delete of document media directory. */
  removeDocDir(userId: string, documentId: string): void {
    try {
      const rel = this.docRelativeDir(userId, documentId);
      const abs = this.resolveSafe(rel);
      fs.rmSync(abs, { recursive: true, force: true });
    } catch (e) {
      this.logger.warn(
        `removeDocDir failed for ${documentId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Generate a unique incoming filename for multer. */
  makeIncomingFilename(originalname: string): string {
    const ext = path.extname(originalname || '').slice(0, 20).replace(/[^\w.]/g, '');
    return `${randomUUID()}${ext || '.bin'}`;
  }

  private moveFile(from: string, to: string) {
    try {
      fs.renameSync(from, to);
    } catch {
      fs.copyFileSync(from, to);
      try {
        fs.unlinkSync(from);
      } catch {
        // ignore
      }
    }
  }

  private assertUuid(value: string, label: string) {
    // UUID v4-ish: only allow hex + hyphens so paths stay safe
    if (!/^[0-9a-fA-F-]{36}$/.test(value)) {
      throw new Error(`invalid ${label} for media path`);
    }
  }
}
