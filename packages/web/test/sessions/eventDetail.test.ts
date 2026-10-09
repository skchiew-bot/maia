import { describe, expect, it } from 'vitest';
import { eventDetail } from '../../src/pages/sessions/EventFeed';

const pushed = (meta: Record<string, unknown>) =>
  eventDetail({ type: 'session.git_pushed', meta: meta as never });

describe('eventDetail: session.git_pushed', () => {
  it('counts what the push gateway did with the refs, from the chained counts alone', () => {
    const base = { sessionId: 'ses_1', credentialProfile: 'deploy-main' };
    expect(pushed({ ...base, refs: 2, forwarded: 1, refused: 1, failed: 0 })).toBe(
      'pushed 2 refs · 1 forwarded · 1 refused',
    );
    expect(pushed({ ...base, refs: 1, forwarded: 1, refused: 0, failed: 0 })).toBe(
      'pushed 1 ref · 1 forwarded',
    );
    expect(pushed({ ...base, refs: 3, forwarded: 0, refused: 2, failed: 1 })).toBe(
      'pushed 3 refs · 0 forwarded · 2 refused · 1 failed',
    );
  });

  it('never prints anything but the counts: a hostile meta value is not echoed', () => {
    const line = pushed({
      sessionId: '<img src=x onerror=alert(1)>',
      credentialProfile: '<script>alert(1)</script>',
      refs: '<b>2</b>',
      forwarded: 1,
      refused: '<i>1</i>',
      failed: 0,
    });
    expect(line).not.toMatch(/[<>]/);
    expect(line).toBe('pushed 0 refs · 1 forwarded');
  });
});
