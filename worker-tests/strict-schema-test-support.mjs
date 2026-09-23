import assert from 'node:assert/strict'

// Mirrors the Azure OpenAI strict structured-output subset independently of the production checker.
export const UNSUPPORTED_STRICT_KEYWORDS = [
  'oneOf', 'allOf', 'not', 'if', 'then', 'else', 'dependentRequired', 'dependentSchemas', 'dependencies',
  'patternProperties', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'contains',
  'minContains', 'maxContains', 'minProperties', 'maxProperties',
]

export function assertStrictSchema(schema, root = true) {
  if (!schema || typeof schema !== 'object') return
  if (root) {
    assert.equal(schema.type, 'object', 'Strict structured outputs require an object root schema')
    assert.equal(schema.anyOf, undefined, 'Strict structured outputs reject a root union')
  }
  if (!Array.isArray(schema)) {
    for (const keyword of UNSUPPORTED_STRICT_KEYWORDS) {
      assert.equal(Object.hasOwn(schema, keyword), false, `Strict structured outputs reject "${keyword}"`)
    }
  }
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false)
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort())
  }
  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) value.forEach(item => assertStrictSchema(item, false))
    else assertStrictSchema(value, false)
  }
}
