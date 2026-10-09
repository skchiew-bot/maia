/**
 * The fixed process-type registry (§2.2): the registry service when mod-registry is loaded, otherwise the
 * validated registry file. The type — and therefore the model — is decided here, never by the requester or agent.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ProcessRegistrySchema,
  routeModel,
  type ModelTier,
  type PlaybookInfo,
  type ProcessType,
} from '@aoc/contracts';
import { HttpError, type ModuleContext } from '@aoc/kernel';

export class RegistryAccess {
  private cache: { mtimeMs: number; types: Map<string, ProcessType> } | null = null;

  constructor(
    private readonly ctx: ModuleContext,
    private readonly file: string,
  ) {}

  getType(id: string): ProcessType | null {
    const svc = this.ctx.services.maybe('registry');
    if (svc) return svc.getType(id);
    return this.fromFile().get(id) ?? null;
  }

  listTypes(): ProcessType[] {
    const svc = this.ctx.services.maybe('registry');
    return svc ? svc.listTypes() : [...this.fromFile().values()];
  }

  /** Discovery-class types always run on their declared model: credits and playbooks never change it (§10, R8). */
  modelFor(t: ProcessType): ModelTier {
    if (t.class === 'discovery') return t.model;
    const svc = this.ctx.services.maybe('registry');
    return svc ? svc.modelFor(t.id) : routeModel(t, false);
  }

  activePlaybook(processType: string): PlaybookInfo | null {
    const p = this.ctx.services.maybe('registry')?.activePlaybook(processType) ?? null;
    return p?.status === 'approved' ? p : null;
  }

  private fromFile(): Map<string, ProcessType> {
    const path = resolve(this.file);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      throw new HttpError(503, 'registry_unavailable', `Process-type registry ${path} is missing`);
    }
    if (this.cache?.mtimeMs === mtimeMs) return this.cache.types;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new HttpError(503, 'registry_invalid', `Process-type registry ${path} is not valid JSON`);
    }
    const parsed = ProcessRegistrySchema.safeParse(raw);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      throw new HttpError(
        503,
        'registry_invalid',
        `Process-type registry ${path} failed validation`,
        problems,
      );
    }
    const types = new Map(parsed.data.types.map((t) => [t.id, t]));
    this.cache = { mtimeMs, types };
    return types;
  }
}
