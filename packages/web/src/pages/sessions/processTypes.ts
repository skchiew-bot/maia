import type { ProcessTypeView, RegistryTypesResponse } from '@aoc/contracts';
import { useResource } from '../../api/useResource';
import { DEFAULT_ROLLOVER_PCT } from './sessionText';

/** The fixed process-type registry (§2.2): rollover threshold and process class per type. */
export function useProcessTypes() {
  return useResource<RegistryTypesResponse>('/api/registry/process-types', {
    refreshOn: (m) => m.kind === 'aoc' && m.event.type.startsWith('registry.'),
  });
}

export function processTypeOf(
  registry: RegistryTypesResponse | undefined,
  processType: string | null | undefined,
): ProcessTypeView | undefined {
  return processType ? registry?.types.find((t) => t.id === processType) : undefined;
}

/** Context share at which this type rolls over (registry default 70 %, migrations later, §5). */
export function rolloverPctFor(
  registry: RegistryTypesResponse | undefined,
  processType: string | null | undefined,
): number {
  return processTypeOf(registry, processType)?.rolloverContextPct ?? DEFAULT_ROLLOVER_PCT;
}

/** Window size implied by the daemon's tokens and percentage, snapped to 100K ("1M"). */
export function impliedWindow(tokens: number | null, pct: number | null): number | null {
  if (tokens === null || pct === null || pct <= 0) return null;
  return Math.round(tokens / (pct / 100) / 100_000) * 100_000 || null;
}
