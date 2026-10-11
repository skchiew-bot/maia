import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebStream } from 'node:stream/web';
import busboy from 'busboy';
import { HttpError } from '@aoc/kernel';
import { declaredMatches, safeFileName, sniff, type SniffResult } from './upload';

const SNIFF_BYTES = 16;

export interface IntakeFile {
  name: string;
  kind: SniffResult;
  buf: Buffer;
}

export interface IntakeForm {
  fields: Map<string, string>;
  files: IntakeFile[];
}

export interface IntakeFormRules {
  maxFiles: number;
  /** Largest text field in bytes; a longer one is refused (the route checks character lengths after). */
  maxFieldBytes: number;
  /** Byte cap for a file of this kind. */
  capFor(kind: SniffResult): number;
  /** Runs when the first file part starts, before any of it is read (e.g. no usable scanner: refuse). */
  beforeFirstFile(): void;
}

/**
 * Reads POST /portal/api/intakes as a stream (O-16): the form is never built in memory as a whole. A file is refused
 * the moment it shows it cannot be accepted (one file too many, magic bytes that are not an accepted type or do not
 * match the declared type, more bytes than its kind allows) and the rest of the request is not read. Each accepted
 * file is held once, joined from its chunks when it ends.
 */
export function readIntakeForm(req: Request, rules: IntakeFormRules): Promise<IntakeForm> {
  const type = req.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data\s*;/i.test(type) || !req.body)
    return Promise.reject(new HttpError(415, 'unsupported_media', 'Send the request as multipart/form-data'));
  return new Promise((resolve, reject) => {
    const fields = new Map<string, string>();
    const files: IntakeFile[] = [];
    let failed = false;
    let started = false;
    let pending = 0;
    let ended = false;
    let bb: busboy.Busboy;
    try {
      bb = busboy({
        headers: { 'content-type': type },
        // Sizes are enforced per kind below, as the bytes arrive. busboy reports a part once its first byte arrives.
        limits: { files: rules.maxFiles, fields: 20, fieldSize: rules.maxFieldBytes, parts: rules.maxFiles + 20 },
      });
    } catch {
      reject(new HttpError(400, 'invalid_form', 'The request is not a valid multipart form'));
      return;
    }
    const source = Readable.fromWeb(req.body as unknown as NodeWebStream<Uint8Array>);
    const fail = (e: unknown) => {
      if (failed) return;
      failed = true;
      source.unpipe(bb);
      source.destroy();
      bb.removeAllListeners();
      bb.on('error', () => {});
      reject(e instanceof HttpError ? e : new HttpError(400, 'invalid_form', 'The request is not a valid multipart form'));
    };
    const done = () => {
      if (!failed && ended && pending === 0) resolve({ fields, files });
    };

    bb.on('field', (name, value, info) => {
      if (info.valueTruncated) return fail(new HttpError(422, 'invalid', 'A form field is too long'));
      fields.set(name, value);
    });
    bb.on('filesLimit', () => fail(new HttpError(413, 'too_many_files', `At most ${rules.maxFiles} attachments`)));
    bb.on('partsLimit', () => fail(new HttpError(413, 'too_many_parts', 'Too many form fields')));
    bb.on('fieldsLimit', () => fail(new HttpError(413, 'too_many_parts', 'Too many form fields')));
    bb.on('file', (name, stream, info) => {
      if (failed) return void stream.resume();
      if (name !== 'files' && name !== 'files[]') return void stream.resume();
      if (!started) {
        started = true;
        try {
          rules.beforeFirstFile();
        } catch (e) {
          stream.resume();
          return fail(e);
        }
      }
      const fileName = safeFileName(info.filename ?? 'file');
      const chunks: Buffer[] = [];
      let bytes = 0;
      let kind: SniffResult | null = null;
      let cap = 0;
      pending++;
      const decide = () => {
        const head = Buffer.concat(chunks).subarray(0, SNIFF_BYTES);
        kind = sniff(head);
        if (!kind) throw new HttpError(415, 'unsupported_media', `${fileName}: only PNG, JPEG, GIF, WebP, MP4, MOV, WebM or PDF are accepted`);
        if (!declaredMatches(info.mimeType, kind)) throw new HttpError(415, 'type_mismatch', `${fileName}: file content does not match its declared type`);
        cap = rules.capFor(kind);
      };
      stream.on('data', (chunk: Buffer) => {
        if (failed) return;
        try {
          chunks.push(chunk);
          bytes += chunk.length;
          if (!kind && bytes >= SNIFF_BYTES) decide();
          if (kind && bytes > cap) throw new HttpError(413, 'too_large', `${fileName} exceeds ${Math.round(cap / 1048576)} MB`);
        } catch (e) {
          fail(e);
        }
      });
      stream.on('end', () => {
        if (failed) return;
        try {
          if (!kind) decide();
          if (bytes > cap) throw new HttpError(413, 'too_large', `${fileName} exceeds ${Math.round(cap / 1048576)} MB`);
          files.push({ name: fileName, kind: kind!, buf: Buffer.concat(chunks, bytes) });
          pending--;
          done();
        } catch (e) {
          fail(e);
        }
      });
      stream.on('error', fail);
    });
    bb.on('error', fail);
    bb.on('close', () => {
      ended = true;
      done();
    });
    source.on('error', fail);
    source.pipe(bb);
  });
}
