import { Fragment } from 'react';
import { inspectAll, inspectText } from '../lib/hiddenText';
import { InlineAlert } from './EmptyState';

/**
 * Untrusted text with what would not show made visible (O-17): each hidden character becomes a marked code point,
 * each word that mixes Latin with look-alike letters is marked. Plain text otherwise, never markup.
 */
export function RevealedText({ text }: { text: string }) {
  const { parts, hidden, mixed } = inspectText(text);
  if (!hidden && !mixed) return <>{text}</>;
  return (
    <>
      {parts.map((p, i) =>
        p.kind === 'text' ? (
          <Fragment key={i}>{p.text}</Fragment>
        ) : p.kind === 'hidden' ? (
          <mark key={i} className="aoc-hidden-char" title={`Hidden character ${p.codePoint}`}>
            [{p.codePoint}]
          </mark>
        ) : (
          <mark key={i} className="aoc-confusable" title="Mixes Latin with look-alike letters from another alphabet">
            {p.text}
          </mark>
        ),
      )}
    </>
  );
}

/** One warning for a set of texts (a card, a lesson) when any of them hides something; nothing otherwise. */
export function HiddenTextWarning({ texts }: { texts: readonly (string | null | undefined)[] }) {
  const { hidden, mixed } = inspectAll(texts);
  if (!hidden && !mixed) return null;
  const what = [
    hidden ? `${hidden} hidden character${hidden === 1 ? '' : 's'}` : null,
    mixed ? `${mixed} word${mixed === 1 ? '' : 's'} mixing alphabets` : null,
  ]
    .filter(Boolean)
    .join(' and ');
  return (
    <InlineAlert tone="warn" title="Text that does not show as it reads">
      This contains {what}, marked below. They can hide instructions from a reader: check before approving.
    </InlineAlert>
  );
}
