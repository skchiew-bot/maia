import type { PublicTicket } from '@aoc/contracts';
import { formatBytes, KIND_WORD, type MediaKind } from './uploads';

/** Kind of an attachment from its (server-sniffed) MIME type. */
export function kindOfMime(mime: string): MediaKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

/** 16px glyphs on the shared icon grid (1.5px strokes, currentColor). */
export function FileGlyph({ kind, size = 16 }: { kind: MediaKind; size?: number }) {
  return (
    <svg
      className="portal-glyph"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {kind === 'image' && (
        <>
          <rect x="2" y="2.75" width="12" height="10.5" rx="1.5" />
          <circle cx="5.75" cy="6.25" r="1.1" />
          <path d="M2.5 11.5l3.25-3 2.5 2.25 2.25-1.75 3 2.5" />
        </>
      )}
      {kind === 'video' && (
        <>
          <rect x="1.75" y="3.25" width="9" height="9.5" rx="1.5" />
          <path d="M10.75 6.5l3.5-2v7l-3.5-2" />
        </>
      )}
      {kind === 'document' && (
        <>
          <path d="M4 1.75h5l3 3v9.5H4z" />
          <path d="M9 1.75v3h3M6 8.25h4M6 10.75h4" />
        </>
      )}
    </svg>
  );
}

/** The requester's own uploads (names and sizes only: raw media is never served back through the portal). */
export function AttachmentList({ attachments }: { attachments: PublicTicket['attachments'] }) {
  return (
    <ul className="portal-files">
      {attachments.map((a) => {
        const kind = kindOfMime(a.mime);
        return (
          <li key={a.attachmentId} className="portal-files__item">
            <span className="portal-files__glyph">
              <FileGlyph kind={kind} />
            </span>
            <span className="portal-files__name">{a.fileName}</span>
            <span className="portal-files__meta aoc-num">
              {KIND_WORD[kind]} · {formatBytes(a.bytes)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
