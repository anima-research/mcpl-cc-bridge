/**
 * Argument checks against a tool's input schema — for MCPL RFC-014 r4 §6.1:
 * "with `instance`, the definition is that instance's own current one (the
 * legal moves of one game), and the host checks arguments for that instance
 * against it". The server checks too; this is the host's check, so a call
 * that one instance's definition rules out is refused before it is sent.
 *
 * A deliberate subset of JSON Schema: type, enum, const, required,
 * properties, additionalProperties, items, min/maxItems, minimum, maximum,
 * exclusiveMinimum/Maximum, min/maxLength, pattern, anyOf, oneOf, allOf.
 * Anything else is not checked (it can only under-reject, never refuse what
 * the server would accept on those keywords).
 */
type Schema = Record<string, unknown>
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function typeOk(t: string, v: unknown): boolean {
  switch (t) {
    case 'object':
      return isObj(v)
    case 'array':
      return Array.isArray(v)
    case 'string':
      return typeof v === 'string'
    case 'number':
      return typeof v === 'number' && Number.isFinite(v)
    case 'integer':
      return Number.isInteger(v)
    case 'boolean':
      return typeof v === 'boolean'
    case 'null':
      return v === null
    default:
      return true
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** The first problem with `value` against `schema`, as a short sentence naming where; null when it fits. */
export function checkArgs(schema: unknown, value: unknown, at = 'args'): string | null {
  if (!isObj(schema)) return null
  const s = schema as Schema
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string]
    if (!types.some(t => typeOk(t, value))) return `${at}: must be ${types.join(' or ')}`
  }
  if (Array.isArray(s.enum) && !s.enum.some(e => same(e, value))) return `${at}: must be one of ${s.enum.map(e => JSON.stringify(e)).join('|')}`
  if (s.const !== undefined && !same(s.const, value)) return `${at}: must be ${JSON.stringify(s.const)}`
  if (typeof value === 'string') {
    const n = [...value].length
    if (typeof s.minLength === 'number' && n < s.minLength) return `${at}: at least ${s.minLength} characters`
    if (typeof s.maxLength === 'number' && n > s.maxLength) return `${at}: at most ${s.maxLength} characters`
    if (typeof s.pattern === 'string') {
      try {
        if (!new RegExp(s.pattern, 'u').test(value)) return `${at}: does not match ${s.pattern}`
      } catch {}
    }
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) return `${at}: at least ${s.minimum}`
    if (typeof s.maximum === 'number' && value > s.maximum) return `${at}: at most ${s.maximum}`
    if (typeof s.exclusiveMinimum === 'number' && value <= s.exclusiveMinimum) return `${at}: more than ${s.exclusiveMinimum}`
    if (typeof s.exclusiveMaximum === 'number' && value >= s.exclusiveMaximum) return `${at}: less than ${s.exclusiveMaximum}`
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) return `${at}: at least ${s.minItems} items`
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) return `${at}: at most ${s.maxItems} items`
    if (isObj(s.items)) {
      for (let i = 0; i < value.length; i++) {
        const e = checkArgs(s.items, value[i], `${at}[${i}]`)
        if (e) return e
      }
    }
  }
  if (isObj(value)) {
    const props = isObj(s.properties) ? (s.properties as Record<string, unknown>) : {}
    for (const r of Array.isArray(s.required) ? (s.required as string[]) : []) if (!(r in value)) return `${at}.${r}: required`
    for (const [k, v] of Object.entries(value)) {
      if (Object.hasOwn(props, k)) {
        const e = checkArgs(props[k], v, `${at}.${k}`)
        if (e) return e
      } else if (s.additionalProperties === false) return `${at}.${k}: not an argument of this tool`
      else if (isObj(s.additionalProperties)) {
        const e = checkArgs(s.additionalProperties, v, `${at}.${k}`)
        if (e) return e
      }
    }
  }
  for (const k of ['anyOf', 'oneOf'] as const) {
    const alts = s[k]
    if (Array.isArray(alts) && alts.length && !alts.some(a => checkArgs(a, value, at) === null)) return checkArgs(alts[0], value, at) ?? `${at}: fits none of the allowed forms`
  }
  if (Array.isArray(s.allOf)) {
    for (const a of s.allOf) {
      const e = checkArgs(a, value, at)
      if (e) return e
    }
  }
  return null
}
