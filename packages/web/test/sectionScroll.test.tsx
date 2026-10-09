import { act, render } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSectionScroll } from '../src/lib/sectionScroll';

type Settled = { data: unknown; error: unknown };
const LOADING: Settled = { data: undefined, error: undefined };
const LOADED: Settled = { data: [], error: undefined };

let scrolled: string[];
let original: typeof Element.prototype.scrollIntoView;
let navigate: ReturnType<typeof useNavigate>;

beforeEach(() => {
  scrolled = [];
  original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.id);
  };
});
afterEach(() => {
  Element.prototype.scrollIntoView = original;
});

function Page({ states }: { states: Settled[] }) {
  useSectionScroll(...states);
  navigate = useNavigate();
  return (
    <>
      <section id="rate-card" />
      <section id="a b" />
    </>
  );
}

const renderAt = (hash: string, states: Settled[]) => {
  const ui = (s: Settled[]) => (
    <MemoryRouter initialEntries={[`/metering${hash}`]}>
      <Page states={s} />
    </MemoryRouter>
  );
  const view = render(ui(states));
  return { rerender: (s: Settled[]) => view.rerender(ui(s)) };
};

describe('useSectionScroll', () => {
  it('waits for every resource to settle, then scrolls to the section the hash names', () => {
    const { rerender } = renderAt('#rate-card', [LOADED, LOADING]);
    expect(scrolled).toEqual([]);
    rerender([LOADED, LOADED]);
    expect(scrolled).toEqual(['rate-card']);
  });

  it('also scrolls when a resource failed: the section may still be on the page', () => {
    renderAt('#rate-card', [{ data: undefined, error: new Error('boom') }]);
    expect(scrolled).toEqual(['rate-card']);
  });

  it('decodes the hash, and ignores a missing target, no hash and a malformed escape', () => {
    renderAt('#a%20b', [LOADED]);
    expect(scrolled).toEqual(['a b']);
    scrolled.length = 0;
    for (const hash of ['', '#', '#nowhere', '#%E0%A4%A']) {
      expect(() => renderAt(hash, [LOADED])).not.toThrow();
    }
    expect(scrolled).toEqual([]);
  });

  it('scrolls again when the same link is followed a second time', async () => {
    renderAt('#rate-card', [LOADED]);
    expect(scrolled).toEqual(['rate-card']);
    await act(async () => navigate('/metering#rate-card'));
    expect(scrolled).toEqual(['rate-card', 'rate-card']);
  });
});
