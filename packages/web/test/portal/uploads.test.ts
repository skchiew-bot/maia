import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api';
import {
  acceptAttribute,
  acceptedSummary,
  checkFile,
  checkSelection,
  declaredMatches,
  DEFAULT_LIMITS,
  describeSubmitError,
  formatBytes,
  readHead,
  safeFileName,
  sniffMedia,
} from '../../src/pages/portal/uploads';

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));

const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'rest');
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0]);
const GIF = bytes('GIF89a....');
const WEBP = bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ');
const MP4 = bytes([0, 0, 0, 0x18], 'ftypisom', [0, 0]);
const MOV = bytes([0, 0, 0, 0x14], 'ftypqt  ', [0, 0]);
const WEBM = bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f]);
const PDF = bytes('%PDF-1.7\n');
const MiB = 1024 * 1024;

describe('client-side upload rules (mirror of mod-intake)', () => {
  it('identifies content by its magic bytes, exactly like the server', () => {
    expect(sniffMedia(PNG)).toEqual({ mime: 'image/png', kind: 'image' });
    expect(sniffMedia(JPEG)).toEqual({ mime: 'image/jpeg', kind: 'image' });
    expect(sniffMedia(GIF)).toEqual({ mime: 'image/gif', kind: 'image' });
    expect(sniffMedia(WEBP)).toEqual({ mime: 'image/webp', kind: 'image' });
    expect(sniffMedia(MP4)).toEqual({ mime: 'video/mp4', kind: 'video' });
    expect(sniffMedia(MOV)).toEqual({ mime: 'video/quicktime', kind: 'video' });
    expect(sniffMedia(WEBM)).toEqual({ mime: 'video/webm', kind: 'video' });
    expect(sniffMedia(PDF)).toEqual({ mime: 'application/pdf', kind: 'document' });
    expect(sniffMedia(bytes('MZ not media'))).toBeNull();
    expect(sniffMedia(bytes([0x89, 0x50]))).toBeNull();
  });

  it('refuses a declared type that contradicts the content, but trusts content when none is declared', () => {
    expect(declaredMatches('image/png', 'image', DEFAULT_LIMITS)).toBe(true);
    expect(declaredMatches('image/jpg', 'image', DEFAULT_LIMITS)).toBe(true);
    expect(declaredMatches('IMAGE/PNG', 'image', DEFAULT_LIMITS)).toBe(true);
    expect(declaredMatches('', 'video', DEFAULT_LIMITS)).toBe(true);
    expect(declaredMatches('application/octet-stream', 'document', DEFAULT_LIMITS)).toBe(true);
    expect(declaredMatches('image/png', 'document', DEFAULT_LIMITS)).toBe(false);
    expect(declaredMatches('text/html', 'image', DEFAULT_LIMITS)).toBe(false);
  });

  it('checks one file with a kind message for each problem', () => {
    const file = (name: string, type: string, size: number) => ({ name, type, size });
    expect(checkFile(file('a.png', 'image/png', 1200), PNG, DEFAULT_LIMITS)).toEqual({ ok: true, kind: 'image', mime: 'image/png' });
    expect(checkFile(file('a.png', 'image/png', 0), PNG, DEFAULT_LIMITS)).toMatchObject({ ok: false, code: 'empty' });
    const unsupported = checkFile(file('setup.exe', 'application/octet-stream', 10), bytes('MZ'), DEFAULT_LIMITS);
    expect(unsupported).toMatchObject({ ok: false, code: 'unsupported' });
    expect(unsupported.ok ? '' : unsupported.message).toContain('PNG, JPEG, GIF or WebP images, MP4, MOV or WebM videos, or PDFs');
    const mismatch = checkFile(file('shot.png', 'image/png', 30), PDF, DEFAULT_LIMITS);
    expect(mismatch).toMatchObject({ ok: false, code: 'type_mismatch' });
    expect(mismatch.ok ? '' : mismatch.message).toMatch(/doesn’t match its type/);
    const bigImage = checkFile(file('big.png', 'image/png', 11 * MiB), PNG, DEFAULT_LIMITS);
    expect(bigImage.ok ? '' : bigImage.message).toBe(
      'This image is 11 MB. Images can be up to 10 MB. Try a smaller screenshot or export.',
    );
    expect(checkFile(file('rec.webm', 'video/webm', 150 * MiB), WEBM, DEFAULT_LIMITS)).toMatchObject({ ok: true, kind: 'video' });
    const bigVideo = checkFile(file('rec.webm', 'video/webm', 201 * MiB), WEBM, DEFAULT_LIMITS);
    expect(bigVideo.ok ? '' : bigVideo.message).toMatch(/Videos can be up to 200 MB\. Try a shorter recording\./);
    // PDFs share the image cap
    expect(checkFile(file('r.pdf', 'application/pdf', 11 * MiB), PDF, DEFAULT_LIMITS)).toMatchObject({ code: 'too_large' });
  });

  it('checks the whole selection: count and combined size', () => {
    expect(checkSelection([{ size: 1 }, { size: 2 }], DEFAULT_LIMITS)).toBeNull();
    expect(checkSelection(Array.from({ length: 7 }, () => ({ size: 1 })), DEFAULT_LIMITS)).toBe(
      'You can attach up to 6 files. Remove 1 to continue.',
    );
    expect(checkSelection([{ size: 150 * MiB }, { size: 60 * MiB }], DEFAULT_LIMITS)).toMatch(
      /^Together your files are 210 MB; one request can carry up to 200 MB\./,
    );
  });

  it('keeps the display name the server keeps, so its messages can be matched to a file', () => {
    expect(safeFileName('../../etc/passwd.png')).toBe('passwd.png');
    expect(safeFileName('C:\\Users\\me\\Screen Shot (2).png')).toBe('Screen Shot (2).png');
    expect(safeFileName('claim<script>.png')).toBe('claim_script_.png');
    expect(safeFileName('')).toBe('file');
  });

  it('formats sizes and the accept list', () => {
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(830)).toBe('830 bytes');
    expect(formatBytes(24 * 1024)).toBe('24 KB');
    expect(formatBytes(1.25 * MiB)).toBe('1.3 MB');
    expect(formatBytes(200 * MiB)).toBe('200 MB');
    expect(acceptedSummary(DEFAULT_LIMITS)).toBe('PNG, JPEG, GIF or WebP images, MP4, MOV or WebM videos, or PDFs');
    expect(acceptAttribute(DEFAULT_LIMITS)).toContain('video/quicktime,.mov');
  });

  it('reads the first bytes of a file', async () => {
    const head = await readHead(new File([PNG, new Uint8Array(100)], 'a.png', { type: 'image/png' }));
    expect(head.length).toBe(16);
    expect(sniffMedia(head)?.mime).toBe('image/png');
  });
});

describe('server refusals become kind messages', () => {
  const files = [{ name: 'Screen Shot.png' }, { name: '../evil.png' }];
  const refused = (status: number, code: string, message: string) =>
    describeSubmitError(new ApiError(status, code, message), files, DEFAULT_LIMITS);

  it('names the file the server refused', () => {
    expect(refused(415, 'type_mismatch', 'evil.png: file content does not match its declared type')).toMatchObject({
      fileIndex: 1,
      message: expect.stringMatching(/^“evil\.png” isn’t what its name says/),
    });
    expect(refused(422, 'rejected', 'Screen Shot.png was rejected by the malware scanner')).toMatchObject({
      fileIndex: 0,
      message: expect.stringMatching(/didn’t pass our safety check/),
    });
    expect(refused(413, 'too_large', 'Screen Shot.png exceeds 10 MB').fileIndex).toBe(0);
    expect(refused(415, 'unsupported_media', 'odd.bin: only PNG…')).toMatchObject({
      fileIndex: undefined,
      message: expect.stringMatching(/^One of your files isn’t a file type we can accept/),
    });
  });

  it('explains limits, outages and form problems without status codes', () => {
    expect(refused(413, 'too_many_files', 'At most 6 attachments').message).toBe(
      'You can attach up to 6 files. Remove some and send again.',
    );
    expect(refused(413, 'payload_too_large', 'Request body exceeds 1 bytes').message).toMatch(/too large to send in one request/);
    expect(refused(503, 'scanner_unavailable', 'x').message).toMatch(/can’t check attachments for safety right now/);
    expect(refused(422, 'invalid', 'Title must be 3–200 characters')).toMatchObject({ field: 'title' });
    expect(refused(422, 'invalid', 'Description must be 10–20000 characters')).toMatchObject({ field: 'description' });
    expect(refused(422, 'invalid', 'Unknown severity')).toMatchObject({ field: 'severity' });
    expect(refused(401, 'unauthenticated', 'x')).toMatchObject({ signedOut: true });
    expect(refused(0, 'network_error', 'x').message).toMatch(/wasn’t sent: we couldn’t reach the service/);
    expect(refused(500, 'internal', 'x').message).not.toMatch(/500|internal/);
  });
});
