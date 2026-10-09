import type { FxService } from '@aoc/contracts';
import type { FxReadModel } from './read-model';
import { isCalendarDate } from './rules';

/** The day's own record, else the latest prior record stamped inherited (keeping its source date), else null. */
export function rateOn(model: FxReadModel, date: string): ReturnType<FxService['rateFor']> {
  if (!isCalendarDate(date)) return null;
  const r = model.latestOnOrBefore(date);
  if (!r) return null;
  return { rate: r.rate, status: r.date === date ? r.status : 'inherited', sourceDate: r.sourceDate };
}

export function createFxService(model: FxReadModel): FxService {
  return { rateFor: (date) => rateOn(model, date) };
}
