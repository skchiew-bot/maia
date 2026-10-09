import { createTestRuntime, type TestRuntimeOptions } from '@aoc/kernel';
import {
  createIdentityModule,
  identityServiceOf,
  identityTestHelpers,
  type IdentityModuleOptions,
} from '../../src';

/** Tests pick their client address with this header (the default resolver reads the socket). */
export const TEST_IP_HEADER = 'x-test-ip';

export async function setupIdentity(
  opts: { identity?: IdentityModuleOptions; config?: TestRuntimeOptions['config']; onDisk?: boolean } = {},
) {
  const mod = createIdentityModule({
    bootstrap: false,
    clientIp: (c) => c.req.header(TEST_IP_HEADER) ?? '198.51.100.7',
    ...opts.identity,
  });
  const t = await createTestRuntime({ modules: [mod], config: opts.config, onDisk: opts.onDisk });
  const service = identityServiceOf(t.rt.services);
  return { t, mod, service, h: identityTestHelpers(service) };
}

/** The aoc_session value from a login response's Set-Cookie header. */
export function sessionCookieFrom(res: Response): string | null {
  return /(?:^|,\s*)aoc_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1] || null;
}

export const ip = (addr: string): Record<string, string> => ({ [TEST_IP_HEADER]: addr });
