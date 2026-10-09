import { describe, expect, it } from 'vitest';
import { combine } from '../src/api';

describe('combine', () => {
  it('has data once every part has loaded, the first error, busy while any part loads, and reloads them all', () => {
    let reloaded = 0;
    const reload = () => {
      reloaded += 1;
    };
    const both = combine(
      { data: 1, error: undefined, loading: false, reload },
      { data: undefined, error: new Error('x'), loading: true, reload },
    );
    expect(both.data).toBeUndefined();
    expect(both.loading).toBe(true);
    expect((both.error as Error).message).toBe('x');
    both.reload();
    expect(reloaded).toBe(2);

    const loaded = combine(
      { data: 'a', error: undefined, loading: false, reload },
      { data: 2, error: undefined, loading: false, reload },
    );
    expect(loaded.data).toEqual(['a', 2]);
    expect(loaded.error).toBeUndefined();
    expect(loaded.loading).toBe(false);
  });
});
