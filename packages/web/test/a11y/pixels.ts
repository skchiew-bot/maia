import type { Page } from './playwright';

/**
 * Whether focusing the element visibly changed it: compares its pixels (plus a ring-sized margin) while
 * focused and after blur. Blurring is safe mid-walk: the next Tab continues from the blurred element.
 */
export async function focusChangesPixels(
  page: Page,
  rect: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
): Promise<boolean> {
  const pad = 5;
  const x = Math.max(0, Math.floor(rect.x - pad));
  const y = Math.max(0, Math.floor(rect.y - pad));
  const width = Math.min(viewport.width, Math.ceil(rect.x + rect.width + pad)) - x;
  const height = Math.min(viewport.height, Math.ceil(rect.y + rect.height + pad)) - y;
  if (width < 2 || height < 2) return true;
  const focused = await page.screenshot({ clip: { x, y, width, height } });
  await page.evaluate('document.activeElement && document.activeElement.blur()');
  const blurred = await page.screenshot({ clip: { x, y, width, height } });
  return !focused.equals(blurred);
}
