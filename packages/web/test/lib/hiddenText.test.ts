import { describe, expect, it } from 'vitest';
import { inspectAll, inspectText } from '../../src/lib/hiddenText';

describe('inspectText (O-17)', () => {
  it('leaves ordinary text, line breaks and accented Latin alone', () => {
    for (const t of ['Run the tests first.\nThen commit.', 'Café naïve résumé', 'Принять изменения', '  tabs\tok '])
      expect(inspectText(t)).toEqual({ parts: [{ kind: 'text', text: t }], hidden: 0, mixed: 0 });
  });

  it('finds zero-width, bidi, tag, odd-blank and control characters by code point', () => {
    const t = 'a​b‮c\u{E0041}d e\u0007f';
    const r = inspectText(t);
    expect(r.hidden).toBe(5);
    expect(r.parts.filter((p) => p.kind === 'hidden').map((p) => (p as { codePoint: string }).codePoint)).toEqual([
      'U+200B',
      'U+202E',
      'U+E0041',
      'U+00A0',
      'U+0007',
    ]);
    expect(r.parts.filter((p) => p.kind === 'text').map((p) => (p as { text: string }).text).join('')).toBe('abcdef');
  });

  it('marks a word that mixes Latin with Cyrillic or Greek look-alikes, not a word in one alphabet', () => {
    const r = inspectText('use the рaypal client, not Ρython or paypal');
    expect(r.mixed).toBe(2);
    expect(r.parts.filter((p) => p.kind === 'mixed').map((p) => (p as { text: string }).text)).toEqual(['рaypal', 'Ρython']);
  });

  it('adds up a whole card', () => {
    expect(inspectAll(['x​y', null, 'ok', 'Ρython'])).toEqual({ hidden: 1, mixed: 1 });
  });
});
