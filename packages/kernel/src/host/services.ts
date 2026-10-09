import type { ServiceMap, ServiceName } from '@aoc/contracts';

/** Typed service registry: modules provide implementations of the contracts' service interfaces. */
export class ServiceRegistry {
  private readonly impls = new Map<ServiceName, unknown>();

  provide<K extends ServiceName>(name: K, impl: ServiceMap[K]): void {
    if (this.impls.has(name)) throw new Error(`service ${name} already provided`);
    this.impls.set(name, impl);
  }

  /** Replace (tests / overrides). */
  override<K extends ServiceName>(name: K, impl: ServiceMap[K]): void {
    this.impls.set(name, impl);
  }

  get<K extends ServiceName>(name: K): ServiceMap[K] {
    const impl = this.impls.get(name);
    if (!impl) throw new Error(`service ${name} is not available (module not loaded?)`);
    return impl as ServiceMap[K];
  }

  maybe<K extends ServiceName>(name: K): ServiceMap[K] | null {
    return (this.impls.get(name) as ServiceMap[K] | undefined) ?? null;
  }

  has(name: ServiceName): boolean {
    return this.impls.has(name);
  }
}
