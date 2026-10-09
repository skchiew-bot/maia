import { focusChangesPixels } from './pixels';
import type { Browser } from './playwright';
import type { Animations, ChartInfo, FocusInfo, Overflow } from './probe';

/** One known defect per gate, so a probe that silently stops firing fails the run instead of passing it. */
const PAGE = `<!doctype html><html lang="en"><head><style>
  :root { --accent: #5d3fd3; --surface: #fff; --mark-drift: #d97706; }
  body { margin: 0; font: 14px sans-serif; background: #f5f6f8; }
  :focus-visible { outline: 2px solid transparent; box-shadow: 0 0 0 2px #fff, 0 0 0 4px var(--accent); }
  .bare:focus { outline: none; box-shadow: none; }
  .spin { width: 10px; height: 10px; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .wide { width: 900px; height: 4px; }
</style></head><body><main id="main">
  <button class="ok">Ringed</button>
  <button class="bare">Bare</button>
  <div class="spin"></div>
  <div class="wide"></div>
  <figure><svg width="200" height="40"><rect width="120" height="40" fill="#5d3fd3"></rect></svg></figure>
  <figure><svg role="img" aria-label="Drift marks" width="200" height="40"><rect width="120" height="40" style="fill: var(--mark-drift)"></rect></svg><figcaption>3 drift marks</figcaption></figure>
</main></body></html>`;

/** Runs every probe against the defect page; returns the checks that did not fire. */
export async function probeSelfTest(browser: Browser, probeSource: string): Promise<string[]> {
  const misses: string[] = [];
  const ctx = await browser.newContext({ viewport: { width: 360, height: 640 }, colorScheme: 'light' });
  try {
    const page = await ctx.newPage();
    await page.goto(`data:text/html,${encodeURIComponent(PAGE)}`);
    await page.evaluate(probeSource);

    const overflow = await page.evaluate<Overflow>('__aocProbe.overflow()');
    if (!overflow.overflows || !overflow.offenders.some((o) => o.selector.includes('wide')))
      misses.push('scroll: a 900px block at 360px was not reported');

    const anim = await page.evaluate<Animations>('__aocProbe.animations()');
    if (!anim.infinite.some((a) => a.selector.includes('spin'))) misses.push('motion: an infinite spin was not reported');

    const charts = await page.evaluate<ChartInfo[]>('__aocProbe.charts()');
    if (!charts[0]?.problem) misses.push('charts: an svg with no role, name or numbers passed');
    if (charts[1]?.problem) misses.push(`charts: a named chart with a printed number failed (${charts[1].problem})`);
    if (!charts[1]?.lowContrastMarks.some((m) => m.token === '--mark-drift'))
      misses.push('charts: drift marks at 2.95:1 on the page background were not reported');

    const viewport = { width: 360, height: 640 };
    await page.keyboard.press('Tab');
    const ringed = await page.evaluate<FocusInfo | null>('__aocProbe.focusInfo()');
    if (ringed?.indicator !== 'ring') misses.push('keyboard: the token focus ring was not recognised');
    if (ringed && !(await focusChangesPixels(page, ringed.rect, viewport)))
      misses.push('keyboard: the pixel check missed a visible focus ring');
    await page.keyboard.press('Tab');
    const bare = await page.evaluate<FocusInfo | null>('__aocProbe.focusInfo()');
    if (bare?.label !== 'Bare') misses.push('keyboard: Tab did not continue after the pixel check blurred focus');
    else if (bare.indicator !== null) misses.push('keyboard: a control with no focus style looked focused');
    else if (await focusChangesPixels(page, bare.rect, viewport))
      misses.push('keyboard: the pixel check saw a focus change on a control with no focus style');
  } finally {
    await ctx.close();
  }
  return misses;
}
