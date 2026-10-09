import type { JsonValue, LlmJsonRequest, LlmJsonResult, LlmService } from '@aoc/contracts';

type Responder = (req: LlmJsonRequest) => JsonValue | Promise<JsonValue>;

/** Scripted LLM: register responses per `purpose` (and optionally per model tier). Records every call. */
export class FakeLlm implements LlmService {
  readonly calls: LlmJsonRequest[] = [];
  private readonly responders = new Map<string, Responder[]>();

  /** Queue a response (consumed in order; the last one repeats). Key = purpose or `${purpose}@${model}`. */
  on(key: string, r: Responder | JsonValue): this {
    const list = this.responders.get(key) ?? [];
    list.push(typeof r === 'function' ? (r as Responder) : () => r as JsonValue);
    this.responders.set(key, list);
    return this;
  }

  async completeJson<T = JsonValue>(req: LlmJsonRequest): Promise<LlmJsonResult<T>> {
    this.calls.push(req);
    const list = this.responders.get(`${req.purpose}@${req.model}`) ?? this.responders.get(req.purpose);
    if (!list?.length) throw new Error(`FakeLlm: no response for ${req.purpose}@${req.model}`);
    const r = list.length > 1 ? list.shift()! : list[0]!;
    const data = (await r(req)) as T;
    return { data, model: req.model, usage: { inputTokens: 100, outputTokens: 20 }, raw: JSON.stringify(data) };
  }
}
