/**
 * `{{name.path}}` templating for scenario steps. Values come from earlier `saveAs` steps plus a `sim`
 * namespace (cwd, sessionId, prompt, lastInput, model). A string that is exactly one placeholder keeps the
 * value's type (so `"confidence": "{{diag.score}}"` stays a number); unresolved placeholders are left as-is
 * so a broken reference stays visible in the transcript instead of silently becoming "".
 */

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_$][A-Za-z0-9_$.-]*)\s*\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{\s*([A-Za-z0-9_$][A-Za-z0-9_$.-]*)\s*\}\}$/;

export type TemplateContext = Readonly<Record<string, unknown>>;

export function lookupPath(context: TemplateContext, dotted: string): unknown {
  let current: unknown = context;
  for (const segment of dotted.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (typeof current === 'object') {
      current = Object.prototype.hasOwnProperty.call(current, segment)
        ? (current as Record<string, unknown>)[segment]
        : undefined;
    } else {
      return undefined;
    }
  }
  return current;
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function renderString(template: string, context: TemplateContext): unknown {
  const whole = WHOLE_PLACEHOLDER.exec(template);
  if (whole) {
    const value = lookupPath(context, whole[1]!);
    return value === undefined ? template : value;
  }
  return template.replace(PLACEHOLDER, (match, dotted: string) => {
    const value = lookupPath(context, dotted);
    return value === undefined ? match : stringify(value);
  });
}

/** Render every string inside `value` (deeply), returning a new structure. */
export function renderDeep<T>(value: T, context: TemplateContext): T {
  if (typeof value === 'string') return renderString(value, context) as T;
  if (Array.isArray(value)) return value.map((item) => renderDeep(item, context)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = renderDeep(item, context);
    return out as T;
  }
  return value;
}

/** Like renderString, but always yields text (for assistant text blocks, commands, stdout). */
export function renderText(template: string, context: TemplateContext): string {
  return stringify(renderString(template, context));
}
