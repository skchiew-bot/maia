import type { IntakeLimits } from '@aoc/contracts';
import { ApiError } from '../../api/client';

/**
 * Client-side mirror of the intake upload rules (mod-intake `upload.ts` and the intake route). It only spares
 * the requester a wasted upload: the server identifies content by its magic bytes and enforces every limit.
 */
export type MediaKind = IntakeLimits['accepted'][number]['kind'];

const MiB = 1024 * 1024;

/** The `intake` config defaults, used until `GET /portal/api/limits` answers. */
export const DEFAULT_LIMITS: IntakeLimits = {
  maxAttachments: 6,
  maxBytes: { image: 10 * MiB, video: 200 * MiB, document: 10 * MiB },
  maxTotalBytes: 200 * MiB,
  titleLength: { min: 3, max: 200 },
  descriptionLength: { min: 10, max: 20_000 },
  accepted: [
    { mime: 'image/png', kind: 'image', extensions: ['.png'] },
    { mime: 'image/jpeg', kind: 'image', extensions: ['.jpg', '.jpeg'] },
    { mime: 'image/gif', kind: 'image', extensions: ['.gif'] },
    { mime: 'image/webp', kind: 'image', extensions: ['.webp'] },
    { mime: 'video/mp4', kind: 'video', extensions: ['.mp4', '.m4v'] },
    { mime: 'video/quicktime', kind: 'video', extensions: ['.mov'] },
    { mime: 'video/webm', kind: 'video', extensions: ['.webm'] },
    { mime: 'application/pdf', kind: 'document', extensions: ['.pdf'] },
  ],
};

/** Bytes the type check needs from the start of a file. */
export const HEAD_BYTES = 16;

export const KIND_WORD: Record<MediaKind, string> = { image: 'Image', video: 'Video', document: 'PDF' };

export interface SniffedMedia {
  mime: string;
  kind: MediaKind;
}

/** Same signatures as the server's `sniff()`. */
export function sniffMedia(b: Uint8Array): SniffedMedia | null {
  const at = (i: number, bytes: number[]) => bytes.every((x, j) => b[i + j] === x);
  const ascii = (start: number, end: number) => String.fromCharCode(...b.subarray(start, end));
  if (b.length >= 8 && at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', kind: 'image' };
  if (b.length >= 3 && at(0, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', kind: 'image' };
  if (b.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return { mime: 'image/gif', kind: 'image' };
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { mime: 'image/webp', kind: 'image' };
  if (b.length >= 12 && ascii(4, 8) === 'ftyp')
    return ascii(8, 12).startsWith('qt') ? { mime: 'video/quicktime', kind: 'video' } : { mime: 'video/mp4', kind: 'video' };
  if (b.length >= 4 && at(0, [0x1a, 0x45, 0xdf, 0xa3])) return { mime: 'video/webm', kind: 'video' };
  if (b.length >= 5 && ascii(0, 5) === '%PDF-') return { mime: 'application/pdf', kind: 'document' };
  return null;
}

/** A declared type that contradicts the content is refused, exactly as the server does. */
export function declaredMatches(declared: string, kind: MediaKind, limits: IntakeLimits): boolean {
  if (!declared || declared === 'application/octet-stream') return true;
  const d = declared.toLowerCase();
  const family = d === 'image/jpg' ? 'image' : limits.accepted.find((a) => a.mime === d)?.kind;
  return family === kind;
}

/** The display name the server keeps for an upload (its `safeFileName`), used to match its messages. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  return base.replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'file';
}

/** `830 bytes`, `24 KB`, `1.2 MB`, `200 MB` (binary units, as the server's messages count them). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} byte${n === 1 ? '' : 's'}`;
  const [value, unit] = n < MiB ? [n / 1024, 'KB'] : [n / MiB, 'MB'];
  const text = value < 10 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value));
  return `${text} ${unit}`;
}

/** "PNG, JPEG, GIF or WebP images, MP4, MOV or WebM videos, or PDFs". */
export function acceptedSummary(limits: IntakeLimits): string {
  const names = (kind: MediaKind) =>
    limits.accepted
      .filter((a) => a.kind === kind)
      .map((a) => FORMAT_NAME[a.mime] ?? a.extensions[0]?.slice(1).toUpperCase() ?? a.mime);
  const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);
  const parts = [
    names('image').length ? `${list(names('image'))} images` : '',
    names('video').length ? `${list(names('video'))} videos` : '',
    names('document').length ? 'PDFs' : '',
  ].filter(Boolean);
  return parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')}, or ${parts[parts.length - 1]}`;
}

const FORMAT_NAME: Record<string, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/gif': 'GIF',
  'image/webp': 'WebP',
  'video/mp4': 'MP4',
  'video/quicktime': 'MOV',
  'video/webm': 'WebM',
  'application/pdf': 'PDF',
};

/** `accept` attribute for the file input. */
export function acceptAttribute(limits: IntakeLimits): string {
  return limits.accepted.flatMap((a) => [a.mime, ...a.extensions]).join(',');
}

export type FileCheck =
  | { ok: true; kind: MediaKind; mime: string }
  | { ok: false; code: 'unsupported' | 'type_mismatch' | 'too_large' | 'empty' | 'unreadable'; message: string };

/** Checks one file from its first bytes, declared type and size. */
export function checkFile(
  file: { name: string; type: string; size: number },
  head: Uint8Array,
  limits: IntakeLimits,
): FileCheck {
  if (file.size === 0) return { ok: false, code: 'empty', message: 'This file is empty. Attach it again.' };
  const sniffed = sniffMedia(head);
  if (!sniffed)
    return {
      ok: false,
      code: 'unsupported',
      message: `We can’t accept this kind of file. Attach ${acceptedSummary(limits)}.`,
    };
  if (!declaredMatches(file.type, sniffed.kind, limits))
    return {
      ok: false,
      code: 'type_mismatch',
      message:
        'This file’s content doesn’t match its type, so we can’t accept it. Save or export it again, then attach the new copy.',
    };
  const cap = limits.maxBytes[sniffed.kind];
  if (file.size > cap) {
    const advice = sniffed.kind === 'video' ? 'Try a shorter recording.' : 'Try a smaller screenshot or export.';
    return {
      ok: false,
      code: 'too_large',
      message: `This ${KIND_WORD[sniffed.kind].toLowerCase()} is ${formatBytes(file.size)}. ${KIND_WORD[sniffed.kind]}s can be up to ${formatBytes(cap)}. ${advice}`,
    };
  }
  return { ok: true, kind: sniffed.kind, mime: sniffed.mime };
}

/** Problems with the whole selection (count, combined size), or null. */
export function checkSelection(files: readonly { size: number }[], limits: IntakeLimits): string | null {
  if (files.length > limits.maxAttachments) {
    const extra = files.length - limits.maxAttachments;
    return `You can attach up to ${limits.maxAttachments} files. Remove ${extra} to continue.`;
  }
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > limits.maxTotalBytes)
    return `Together your files are ${formatBytes(total)}; one request can carry up to ${formatBytes(limits.maxTotalBytes)}. Remove a file or use a shorter video.`;
  return null;
}

/** Reads the first bytes of a file for the type check (FileReader where Blob#arrayBuffer is missing). */
export async function readHead(file: Blob): Promise<Uint8Array> {
  const slice = file.slice(0, HEAD_BYTES);
  if (typeof slice.arrayBuffer === 'function') return new Uint8Array(await slice.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(slice);
  });
}

export type SubmitField = 'title' | 'description' | 'severity';

export interface SubmitProblem {
  message: string;
  /** Index of the attachment the server refused. */
  fileIndex?: number;
  /** Form field the server refused. */
  field?: SubmitField;
  /** The requester must sign in again. */
  signedOut?: boolean;
}

/** Turns a refused submission into a kind message, pointing at the file or field when the server names one. */
export function describeSubmitError(error: unknown, files: readonly { name: string }[], limits: IntakeLimits): SubmitProblem {
  if (!(error instanceof ApiError)) return { message: 'Your request wasn’t sent. Try again.' };
  const fileIndex = fileNamedIn(error.message, files);
  const name = fileIndex === undefined ? 'One of your files' : `“${safeFileName(files[fileIndex]!.name)}”`;
  switch (error.code) {
    case 'unsupported_media':
      return { fileIndex, message: `${name} isn’t a file type we can accept. Attach ${acceptedSummary(limits)}.` };
    case 'type_mismatch':
      return {
        fileIndex,
        message: `${name} isn’t what its name says: its content doesn’t match its file type, so we couldn’t accept it. Save or export it again, then attach the new copy.`,
      };
    case 'too_large':
      return {
        fileIndex,
        message: `${name} is too large. Images and PDFs can be up to ${formatBytes(limits.maxBytes.image)}, videos up to ${formatBytes(limits.maxBytes.video)}.`,
      };
    case 'rejected':
      return {
        fileIndex,
        message: `${name} didn’t pass our safety check, so we couldn’t accept it. If you think it is fine, take a fresh screenshot or recording and attach that instead.`,
      };
    case 'too_many_files':
      return { message: `You can attach up to ${limits.maxAttachments} files. Remove some and send again.` };
    case 'payload_too_large':
      return {
        message: 'Together your files are too large to send in one request. Remove a file or use a shorter video.',
      };
    case 'scanner_unavailable':
      return {
        message:
          'We can’t check attachments for safety right now. Try again in a few minutes, or send your request without attachments.',
      };
  }
  if (error.status === 422) {
    if (/^title/i.test(error.message))
      return {
        field: 'title',
        message: `Give your request a short summary of ${limits.titleLength.min} to ${limits.titleLength.max} characters.`,
      };
    if (/^description/i.test(error.message))
      return {
        field: 'description',
        message: `Describe what happened in at least ${limits.descriptionLength.min} characters.`,
      };
    if (/severity/i.test(error.message)) return { field: 'severity', message: 'Choose how much this affects you.' };
    return { message: 'We couldn’t file this request right now. Try again later.' };
  }
  if (error.status === 401) return { signedOut: true, message: 'You have been signed out. Sign in again to send your request.' };
  if (error.status === 403) return { message: 'Your account can’t send requests here.' };
  if (error.status === 0)
    return { message: 'Your request wasn’t sent: we couldn’t reach the service. Check your connection and try again.' };
  return { message: 'Something went wrong on our side and your request wasn’t sent. Try again in a moment.' };
}

/** The attachment a server message starts with (it names files by their safe display name). */
function fileNamedIn(message: string, files: readonly { name: string }[]): number | undefined {
  let best: number | undefined;
  let bestLength = 0;
  files.forEach((f, i) => {
    const safe = safeFileName(f.name);
    if (message.startsWith(safe) && safe.length > bestLength) {
      best = i;
      bestLength = safe.length;
    }
  });
  return best;
}
