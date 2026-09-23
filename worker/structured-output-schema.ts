import { z } from 'zod'

/**
 * Azure OpenAI strict structured outputs accept only a subset of JSON Schema. A request that uses any of these
 * keywords is rejected with HTTP 400 before the model reads it, so Score must never send them.
 */
export const UNSUPPORTED_STRICT_SCHEMA_KEYWORDS = [
  'oneOf', 'allOf', 'not', 'if', 'then', 'else', 'dependentRequired', 'dependentSchemas', 'dependencies',
  'patternProperties', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'contains',
  'minContains', 'maxContains', 'minProperties', 'maxProperties',
] as const

export class StructuredOutputSchemaError extends Error {
  constructor(readonly path: string, readonly detail: string) {
    super(`The structured-output schema is not compatible with strict mode at ${path || '/'}: ${detail}`)
    this.name = 'StructuredOutputSchemaError'
  }
}

type JsonObject = Record<string, unknown>

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value)
const pointer = (path: string, key: string | number) => `${path}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`

// Walks only schema positions, so property names such as "not" or "if" are never mistaken for keywords.
function visitSchemas(node: unknown, path: string, visit: (node: JsonObject, path: string) => void): void {
  if (!isObject(node)) throw new StructuredOutputSchemaError(path, 'every subschema must be a JSON object.')
  visit(node, path)
  for (const keyword of ['properties', '$defs', 'definitions'] as const) {
    const children = node[keyword]
    if (isObject(children)) for (const [key, child] of Object.entries(children)) visitSchemas(child, pointer(pointer(path, keyword), key), visit)
  }
  for (const keyword of ['anyOf', 'oneOf', 'prefixItems'] as const) {
    const children = node[keyword]
    if (Array.isArray(children)) children.forEach((child, index) => visitSchemas(child, pointer(pointer(path, keyword), index), visit))
  }
  if (Array.isArray(node.items)) node.items.forEach((child, index) => visitSchemas(child, pointer(pointer(path, 'items'), index), visit))
  else if (node.items !== undefined) visitSchemas(node.items, pointer(path, 'items'), visit)
  if (isObject(node.additionalProperties)) visitSchemas(node.additionalProperties, pointer(path, 'additionalProperties'), visit)
}

/** Throws before any network call when a response schema would be rejected by strict structured outputs. */
export function assertStrictStructuredOutputSchema(schema: unknown): void {
  if (!isObject(schema) || schema.type !== 'object') throw new StructuredOutputSchemaError('', 'the root must be an object schema.')
  if (schema.anyOf !== undefined) throw new StructuredOutputSchemaError('/anyOf', 'the root cannot be a union.')
  visitSchemas(schema, '', (node, path) => {
    for (const keyword of UNSUPPORTED_STRICT_SCHEMA_KEYWORDS) {
      if (keyword in node) throw new StructuredOutputSchemaError(pointer(path, keyword), `"${keyword}" is not supported.`)
    }
    const types = Array.isArray(node.type) ? node.type : node.type === undefined ? [] : [node.type]
    if (!types.length && !['anyOf', '$ref', 'enum', 'const'].some(keyword => keyword in node)) {
      throw new StructuredOutputSchemaError(path, 'every subschema needs a type, enum, const, anyOf, or $ref.')
    }
    if (!types.includes('object') && node.properties === undefined) return
    if (node.additionalProperties !== false) throw new StructuredOutputSchemaError(pointer(path, 'additionalProperties'), 'objects must set additionalProperties to false.')
    const required = Array.isArray(node.required) ? node.required : []
    const optional = Object.keys(isObject(node.properties) ? node.properties : {}).filter(key => !required.includes(key))
    if (optional.length) throw new StructuredOutputSchemaError(pointer(path, 'required'), `every property must be required (optional: ${optional.join(', ')}).`)
  })
}

/**
 * Converts a local Zod contract into the JSON Schema sent to the model. Zod emits `oneOf` for discriminated unions;
 * strict mode accepts only `anyOf`. Branches remain distinguished by their discriminator, and the full Zod schema
 * still validates every response locally, so the substitution cannot admit output the contract would reject.
 */
export function strictStructuredOutputSchema(schema: z.ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema) as Record<string, unknown>
  delete result.$schema
  visitSchemas(result, '', (node, path) => {
    if (node.oneOf === undefined) return
    if (node.anyOf !== undefined) throw new StructuredOutputSchemaError(path, 'a subschema cannot combine oneOf and anyOf.')
    node.anyOf = node.oneOf
    delete node.oneOf
  })
  assertStrictStructuredOutputSchema(result)
  return result
}
