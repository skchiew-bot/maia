import { useEffect, useRef, useState } from 'react';
import { cx } from '../lib/dom';
import { shortHash } from '../lib/format';
import { Icon } from './Icon';

export interface CopyableHashProps {
  /** Full hash / SHA / id. Only the short form is shown; the copy button copies all of it. */
  value: string;
  /** Characters shown. Default 8. */
  length?: number;
  /** What the hash identifies ("Commit", "Chain head") — used in the copy button's accessible name. */
  label?: string;
  /** Hide the copy button (e.g. in dense rows that already have a detail view). Default true. */
  copyable?: boolean;
  className?: string;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path (insecure origins, denied permission).
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Monospace short hash with the full value in its title and a copy button that confirms in words. */
export function CopyableHash({
  value,
  length = 8,
  label = 'hash',
  copyable = true,
  className,
}: CopyableHashProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onCopy = async () => {
    const ok = await copyText(value);
    setState(ok ? 'copied' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2000);
  };

  return (
    <span className={cx('aoc-hash', className)}>
      <code className="aoc-hash__value" title={value}>
        {shortHash(value, length)}
      </code>
      {copyable && (
        <button
          type="button"
          className="aoc-hash__copy"
          onClick={onCopy}
          aria-label={state === 'copied' ? `Copied ${label}` : `Copy full ${label}`}
          title={state === 'copied' ? 'Copied' : `Copy full ${label}`}
        >
          <Icon name={state === 'copied' ? 'check' : 'copy'} size={12} />
        </button>
      )}
      <span className="aoc-sr-only" aria-live="polite">
        {state === 'copied' ? 'Copied to clipboard' : state === 'failed' ? 'Copy failed' : ''}
      </span>
    </span>
  );
}
