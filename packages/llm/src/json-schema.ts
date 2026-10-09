/**
 * Minimal JSON Schema (draft 2020-12 subset) validator for structured LLM output: type, enum, const,
 * object properties/required/additionalProperties, array items/minItems/maxItems, number bounds,
 * string length/pattern, anyOf/oneOf/allOf. Unknown keywords are ignored. Returns problems ("" = valid).
 */
type Schema = Record<string, unknown> | boolean;

export function validateJsonSchema(schema: Schema, value: unknown, path = '$'): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${path}: not allowed`];
  const problems: string[] = [];

  const type = schema.type;
  if (type !== undefined) {
    const types = Array.isArray(type) ? (type as string[]) : [type as string];
    if (!types.some((t) => matchesType(t, value))) {
      return [`${path}: expected ${types.join(' | ')}, got ${describe(value)}`];
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
    problems.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
  }
  if ('const' in schema && !deepEqual(schema.const, value)) {
    problems.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  }

  if (typeof value === 'number') {
    const n = (k: string) => (typeof schema[k] === 'number' ? (schema[k] as number) : undefined);
    const min = n('minimum');
    const max = n('maximum');
    const xmin = n('exclusiveMinimum');
    const xmax = n('exclusiveMaximum');
    if (min !== undefined && value < min) problems.push(`${path}: must be >= ${min}`);
    if (max !== undefined && value > max) problems.push(`${path}: must be <= ${max}`);
    if (xmin !== undefined && value <= xmin) problems.push(`${path}: must be > ${xmin}`);
    if (xmax !== undefined && value >= xmax) problems.push(`${path}: must be < ${xmax}`);
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      problems.push(`${path}: shorter than ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      problems.push(`${path}: longer than ${schema.maxLength}`);
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
      problems.push(`${path}: does not match ${schema.pattern}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      problems.push(`${path}: fewer than ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      problems.push(`${path}: more than ${schema.maxItems} items`);
    }
    if (isSchema(schema.items)) {
      value.forEach((v, i) =>
        problems.push(...validateJsonSchema(schema.items as Schema, v, `${path}[${i}]`)),
      );
    }
  }

  if (isPlainObject(value)) {
    const props = isPlainObject(schema.properties) ? (schema.properties as Record<string, Schema>) : {};
    if (Array.isArray(schema.required)) {
      for (const k of schema.required as string[])
        if (value[k] === undefined) problems.push(`${path}.${k}: required`);
    }
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      if (k in props) problems.push(...validateJsonSchema(props[k]!, v, `${path}.${k}`));
      else if (schema.additionalProperties === false) problems.push(`${path}.${k}: unexpected property`);
      else if (isPlainObject(schema.additionalProperties)) {
        problems.push(...validateJsonSchema(schema.additionalProperties as Schema, v, `${path}.${k}`));
      }
    }
  }

  const branches = (k: string) => (Array.isArray(schema[k]) ? (schema[k] as Schema[]) : null);
  const allOf = branches('allOf');
  if (allOf) for (const s of allOf) problems.push(...validateJsonSchema(s, value, path));
  const anyOf = branches('anyOf');
  if (anyOf && !anyOf.some((s) => validateJsonSchema(s, value, path).length === 0)) {
    problems.push(`${path}: matches no anyOf branch`);
  }
  const oneOf = branches('oneOf');
  if (oneOf && oneOf.filter((s) => validateJsonSchema(s, value, path).length === 0).length !== 1) {
    problems.push(`${path}: must match exactly one oneOf branch`);
  }
  return problems;
}

function matchesType(t: string, v: unknown): boolean {
  switch (t) {
    case 'object':
      return isPlainObject(v);
    case 'array':
      return Array.isArray(v);
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'null':
      return v === null;
    default:
      return true;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isSchema(v: unknown): boolean {
  return typeof v === 'boolean' || isPlainObject(v);
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number' && !Number.isFinite(v)) return 'non-finite number';
  return typeof v;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}
