import { describe, expect, it } from 'vitest';
import { LlmOutputInvalidError, parseJsonText, validateJsonSchema } from '../src';

const schema = {
  type: 'object',
  properties: {
    rate: { type: 'number', minimum: 1, exclusiveMaximum: 10 },
    kind: { type: 'string', enum: ['live', 'inherited'] },
    note: { type: 'string', maxLength: 5 },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
    count: { type: 'integer' },
    maybe: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['rate', 'kind'],
  additionalProperties: false,
};

describe('validateJsonSchema', () => {
  it('accepts a conforming value', () => {
    expect(
      validateJsonSchema(schema, { rate: 4.2, kind: 'live', tags: ['a'], count: 3, maybe: null }),
    ).toEqual([]);
  });

  it('reports required, type, enum, bounds, length, items and unknown keys', () => {
    expect(validateJsonSchema(schema, { kind: 'x', extra: 1 }).sort()).toEqual([
      '$.extra: unexpected property',
      '$.kind: must be one of ["live","inherited"]',
      '$.rate: required',
    ]);
    expect(validateJsonSchema(schema, { rate: 0.5, kind: 'live' })).toEqual(['$.rate: must be >= 1']);
    expect(validateJsonSchema(schema, { rate: 10, kind: 'live' })).toEqual(['$.rate: must be < 10']);
    expect(validateJsonSchema(schema, { rate: '4.2', kind: 'live' })).toEqual([
      '$.rate: expected number, got string',
    ]);
    expect(validateJsonSchema(schema, { rate: Number.NaN, kind: 'live' })).toEqual([
      '$.rate: expected number, got non-finite number',
    ]);
    expect(validateJsonSchema(schema, { rate: 2, kind: 'live', note: 'too long' })).toEqual([
      '$.note: longer than 5',
    ]);
    expect(validateJsonSchema(schema, { rate: 2, kind: 'live', tags: ['a', 1, 'c'] })).toEqual([
      '$.tags: more than 2 items',
      '$.tags[1]: expected string, got number',
    ]);
    expect(validateJsonSchema(schema, { rate: 2, kind: 'live', count: 1.5 })).toEqual([
      '$.count: expected integer, got number',
    ]);
    expect(validateJsonSchema(schema, { rate: 2, kind: 'live', maybe: 3 })).toEqual([
      '$.maybe: matches no anyOf branch',
    ]);
    expect(validateJsonSchema(schema, [1])).toEqual(['$: expected object, got array']);
  });
});

describe('parseJsonText', () => {
  it('parses plain, fenced and embedded JSON', () => {
    expect(parseJsonText('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonText('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseJsonText('Here you go: {"a":3} — done')).toEqual({ a: 3 });
  });
  it('throws LlmOutputInvalidError for non-JSON', () => {
    expect(() => parseJsonText('the rate is 4.21')).toThrow(LlmOutputInvalidError);
  });
});
