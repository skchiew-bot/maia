import { z } from 'zod';

export interface EventDefinition<
  TType extends string = string,
  TMeta extends z.ZodTypeAny = z.ZodTypeAny,
  TPayload extends z.ZodTypeAny | null = z.ZodTypeAny | null,
> {
  type: TType;
  /** Module that owns (emits) this event type. */
  owner: string;
  description: string;
  meta: TMeta;
  /** null → header-only event (no body). */
  payload: TPayload;
}

export function defineEvent<TType extends string, TMeta extends z.ZodTypeAny, TPayload extends z.ZodTypeAny | null>(
  def: EventDefinition<TType, TMeta, TPayload>,
): EventDefinition<TType, TMeta, TPayload> {
  return def;
}

/** Strict meta object: unknown keys are rejected so free text cannot leak into the clear-text chain. */
export const meta = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
/** Payload object: validated, unknown keys preserved (it is encrypted anyway). */
export const payload = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();

// Shared field schemas
export const zId = z.string().min(1).max(64);
export const zIso = z.string().min(10).max(40);
export const zSha = z.string().regex(/^[0-9a-f]{7,64}$/);
export const zHash = z.string().regex(/^[0-9a-f]{64}$/);
export const zLabel = z.string().min(1).max(80).regex(/^[a-z0-9_.:/-]+$/i, 'machine label');
export const zNonNeg = z.number().finite().min(0);
export const zUsd = z.number().finite();

export type EventMapOf<TDefs extends readonly EventDefinition[]> = {
  [D in TDefs[number] as D['type']]: {
    meta: z.infer<D['meta']>;
    payload: D['payload'] extends z.ZodTypeAny ? z.infer<D['payload']> : null;
  };
};
