import type { IntakeLimits } from '@aoc/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { checkFile, checkSelection, readHead, safeFileName, sniffMedia, type FileCheck } from './uploads';

export interface Attachment {
  id: string;
  file: File;
  /** First bytes of the file once read; the check is derived from them and the current limits. */
  head: Uint8Array | null;
  /** The browser could not read the file. */
  unreadable: boolean;
  /** Object URL for an image or video preview. */
  preview: string | null;
  /** Why the server refused this file on the last attempt. */
  refused: string | null;
}

export interface CheckedAttachment extends Attachment {
  /** null while the file is being read. */
  check: FileCheck | null;
}

export interface AttachmentsState {
  items: CheckedAttachment[];
  /** Files that were not added (limit reached, duplicates). Cleared on the next change. */
  notice: string | null;
  /** Problem with the whole selection (count, combined size). */
  selectionProblem: string | null;
  totalBytes: number;
  pending: boolean;
  add: (files: readonly File[]) => void;
  remove: (id: string) => void;
  markRefused: (index: number, message: string) => void;
}

const UNREADABLE: FileCheck = {
  ok: false,
  code: 'unreadable',
  message: 'We couldn’t read this file. Attach it again.',
};

const sameFile = (a: File, b: File) =>
  a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

/** Selected files with their client-side checks and previews (object URLs are revoked when no longer shown). */
export function useAttachments(limits: IntakeLimits): AttachmentsState {
  const [items, setItems] = useState<Attachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const counter = useRef(0);
  const live = useRef(new Set<string>());
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(
    () => () => {
      for (const a of itemsRef.current) if (a.preview) URL.revokeObjectURL(a.preview);
    },
    [],
  );

  const add = useCallback(
    (files: readonly File[]) => {
      const current = itemsRef.current;
      const fresh = files.filter((f) => !current.some((a) => sameFile(a.file, f)));
      const duplicates = files.length - fresh.length;
      const room = Math.max(0, limits.maxAttachments - current.length);
      const accepted = fresh.slice(0, room);
      const skipped = fresh.slice(room);
      const notes: string[] = [];
      if (skipped.length)
        notes.push(
          `You can attach up to ${limits.maxAttachments} files, so ${skipped.map((f) => `“${safeFileName(f.name)}”`).join(', ')} ${skipped.length === 1 ? 'was' : 'were'} not added.`,
        );
      if (duplicates)
        notes.push(
          duplicates === 1 ? 'That file is already attached.' : 'Some of those files are already attached.',
        );
      setNotice(notes.length ? notes.join(' ') : null);
      if (!accepted.length) return;

      const added: Attachment[] = accepted.map((file) => {
        counter.current += 1;
        const id = `att-${counter.current}`;
        live.current.add(id);
        return { id, file, head: null, unreadable: false, preview: null, refused: null };
      });
      setItems((prev) => [...prev.map((a) => ({ ...a, refused: null })), ...added]);
      for (const a of added) {
        readHead(a.file).then(
          (head) => {
            if (!live.current.has(a.id)) return;
            const kind = sniffMedia(head)?.kind;
            const preview =
              (kind === 'image' || kind === 'video') && typeof URL.createObjectURL === 'function'
                ? URL.createObjectURL(a.file)
                : null;
            setItems((prev) => prev.map((x) => (x.id === a.id ? { ...x, head, preview } : x)));
          },
          () => {
            if (live.current.has(a.id))
              setItems((prev) => prev.map((x) => (x.id === a.id ? { ...x, unreadable: true } : x)));
          },
        );
      }
    },
    [limits.maxAttachments],
  );

  const remove = useCallback((id: string) => {
    live.current.delete(id);
    setNotice(null);
    setItems((prev) => {
      const gone = prev.find((a) => a.id === id);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return prev.filter((a) => a.id !== id).map((a) => ({ ...a, refused: null }));
    });
  }, []);

  const markRefused = useCallback((index: number, message: string) => {
    setItems((prev) => prev.map((a, i) => (i === index ? { ...a, refused: message } : a)));
  }, []);

  const checked = useMemo<CheckedAttachment[]>(
    () =>
      items.map((a) => ({
        ...a,
        check: a.unreadable ? UNREADABLE : a.head ? checkFile(a.file, a.head, limits) : null,
      })),
    [items, limits],
  );
  const files = useMemo(() => items.map((a) => a.file), [items]);
  return {
    items: checked,
    notice,
    selectionProblem: checkSelection(files, limits),
    totalBytes: files.reduce((n, f) => n + f.size, 0),
    pending: checked.some((a) => a.check === null),
    add,
    remove,
    markRefused,
  };
}
