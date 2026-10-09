/**
 * Compact display form of a ULID-based id: the type prefix plus the random tail ("chg_…HK2621"). The leading
 * characters encode the creation time, so records made within the same second would otherwise look alike.
 */
export function shortId(id: string): string {
  const i = id.indexOf('_');
  const body = i > 0 ? id.slice(i + 1) : id;
  if (body.length <= 8) return id;
  return `${i > 0 ? id.slice(0, i + 1) : ''}…${body.slice(-6)}`;
}
