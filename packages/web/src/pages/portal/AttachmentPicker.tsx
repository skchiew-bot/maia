import type { IntakeLimits } from '@aoc/contracts';
import { useId, useRef, useState, type DragEvent } from 'react';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/Button';
import { cx } from '../../lib/dom';
import { FileGlyph } from './files';
import type { AttachmentsState, CheckedAttachment } from './useAttachments';
import { acceptAttribute, acceptedSummary, formatBytes, KIND_WORD, safeFileName } from './uploads';

export interface AttachmentPickerProps {
  attachments: AttachmentsState;
  limits: IntakeLimits;
  disabled?: boolean;
}

/**
 * Screenshots, recordings and PDFs: choose, drop or paste. Each file is checked in the browser against the
 * server's rules before anything is uploaded, and problems say what to do next.
 */
export function AttachmentPicker({ attachments, limits, disabled }: AttachmentPickerProps) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const { items, notice, selectionProblem, totalBytes, add, remove } = attachments;
  const full = items.length >= limits.maxAttachments;

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    if (disabled) return;
    add(Array.from(e.dataTransfer.files));
  };

  return (
    <fieldset className="portal-field portal-attach" disabled={disabled} aria-describedby={`${id}-rules`}>
      <legend className="aoc-field__label">
        Screenshots or a recording <span className="aoc-field__required">(optional)</span>
      </legend>
      <p id={`${id}-rules`} className="aoc-field__hint">
        Up to {limits.maxAttachments} files: {acceptedSummary(limits)}. Images and PDFs up to{' '}
        {formatBytes(limits.maxBytes.image)} each, videos up to {formatBytes(limits.maxBytes.video)}.
      </p>
      <div
        className={cx('portal-drop', dragging && 'is-dragging', full && 'is-full')}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled && !full) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <Icon name="upload" size={20} className="portal-drop__icon" />
        <p className="portal-drop__text">
          {full ? (
            <>That&apos;s the most files one request can carry.</>
          ) : (
            <>
              Drag files here, paste a screenshot, or{' '}
              <button
                type="button"
                className="portal-drop__choose"
                onClick={() => inputRef.current?.click()}
                disabled={disabled}
              >
                choose files
              </button>
            </>
          )}
        </p>
        <input
          ref={inputRef}
          id={`${id}-input`}
          className="aoc-sr-only"
          type="file"
          multiple
          accept={acceptAttribute(limits)}
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            add(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </div>
      {notice && (
        <p className="portal-attach__notice" role="status">
          <Icon name="info" size={14} />
          {notice}
        </p>
      )}
      {items.length > 0 && (
        <>
          <ul className="portal-attach__list" aria-label="Attached files">
            {items.map((a) => (
              <AttachmentRow key={a.id} item={a} onRemove={() => remove(a.id)} disabled={disabled} />
            ))}
          </ul>
          <p className="portal-attach__total aoc-num">
            {items.length} of {limits.maxAttachments} files · {formatBytes(totalBytes)}
          </p>
        </>
      )}
      {selectionProblem && (
        <p className="aoc-field__error" role="alert">
          <Icon name="danger" size={12} />
          {selectionProblem}
        </p>
      )}
    </fieldset>
  );
}

function AttachmentRow({ item, onRemove, disabled }: { item: CheckedAttachment; onRemove: () => void; disabled?: boolean }) {
  const { check } = item;
  const problem = item.refused ?? (check && !check.ok ? check.message : null);
  const kind = check?.ok ? check.kind : null;
  const name = safeFileName(item.file.name);
  return (
    <li className={cx('portal-attach__item', problem && 'is-invalid')}>
      <span className="portal-attach__thumb" aria-hidden="true">
        {item.preview && kind === 'image' ? (
          <img src={item.preview} alt="" />
        ) : item.preview && kind === 'video' ? (
          <video src={item.preview} muted playsInline preload="metadata" />
        ) : (
          <FileGlyph kind={kind ?? 'document'} size={20} />
        )}
      </span>
      <span className="portal-attach__info">
        <span className="portal-attach__name">{name}</span>
        <span className="portal-attach__meta aoc-num">
          {check === null ? 'Checking…' : `${kind ? KIND_WORD[kind] : 'File'} · ${formatBytes(item.file.size)}`}
          {check?.ok && !item.refused && (
            <span className="portal-attach__ok">
              <Icon name="check" size={12} /> Ready to send
            </span>
          )}
        </span>
        {problem && (
          <span className="portal-attach__problem">
            <Icon name="danger" size={12} />
            {problem}
          </span>
        )}
      </span>
      <IconButton icon="close" label={`Remove ${name}`} size="sm" onClick={onRemove} disabled={disabled} />
    </li>
  );
}
