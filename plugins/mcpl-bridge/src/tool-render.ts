/**
 * How a tool reads to a model when it arrives in the conversation instead of
 * the tool list (MCPL RFC-014 §8.3): compact signatures, a first sentence the
 * first time a definition is shown, the full schema on request.
 *
 * Ported from surfaces-mcpl src/schema.ts (`signature`, `typeSig`,
 * `firstSentence`, `renderToolDefinition`) — the rendering its revision 1
 * shipped and that read well in use. Kept dependency-free here.
 */
import { createHash } from 'crypto'

export type JsonSchema = Record<string, unknown>
export type ToolDef = { name: string; description?: string; inputSchema?: unknown; annotations?: unknown; _meta?: Record<string, unknown> }

function typeSig(schema: JsonSchema | undefined, depth = 0): string {
  if (!schema || typeof schema !== 'object') return 'any'
  if (Array.isArray(schema.enum)) {
    // The enum is often the menu (a decision's options): show all of it unless it is genuinely long.
    const vals = (schema.enum as unknown[]).map(v => JSON.stringify(v))
    if (vals.length <= 8 || vals.join('|').length <= 400) return vals.join('|')
    let shown = 0
    let len = 0
    while (shown < vals.length && len + vals[shown]!.length < 300) {
      len += vals[shown]!.length + 1
      shown++
    }
    return `${vals.slice(0, Math.max(shown, 4)).join('|')}|…(${vals.length} in all; look {server, tool} lists them)`
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const)
  const alts = (schema.oneOf ?? schema.anyOf) as JsonSchema[] | undefined
  if (Array.isArray(alts)) return alts.map(s => typeSig(s, depth + 1)).join(' | ')
  const t = Array.isArray(schema.type) ? (schema.type as string[]).join('|') : (schema.type as string | undefined)
  switch (t) {
    case 'integer':
    case 'number': {
      const base = t === 'integer' ? 'int' : 'number'
      const lo = schema.minimum as number | undefined
      const hi = schema.maximum as number | undefined
      if (lo !== undefined && hi !== undefined) return `${base} ${lo}..${hi}`
      if (lo !== undefined) return `${base} ≥${lo}`
      if (hi !== undefined) return `${base} ≤${hi}`
      return base
    }
    case 'array': {
      const inner = typeSig(schema.items as JsonSchema | undefined, depth + 1)
      const wrapped = /[ |]/.test(inner) && !inner.startsWith('{') ? `(${inner})` : inner
      const max = schema.maxItems !== undefined ? `≤${schema.maxItems as number}` : ''
      return `${wrapped}[${max}]`
    }
    case 'object': {
      const props = schema.properties as Record<string, JsonSchema> | undefined
      if (!props || Object.keys(props).length === 0) return 'object'
      if (depth >= 3) return '{…}'
      const req = new Set((schema.required as string[] | undefined) ?? [])
      return `{${Object.entries(props).map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${typeSig(v, depth + 1)}`).join(', ')}}`
    }
    case undefined:
      return 'any'
    default:
      return t
  }
}

const schemaOf = (tool: ToolDef): JsonSchema => (tool.inputSchema && typeof tool.inputSchema === 'object' ? (tool.inputSchema as JsonSchema) : {})

/** `play(point: string)`, `move(forward?: int -10..10 =0, turn?: int)` */
export function signature(tool: ToolDef): string {
  const s = schemaOf(tool)
  const props = (s.properties && typeof s.properties === 'object' ? s.properties : {}) as Record<string, JsonSchema>
  const req = new Set(Array.isArray(s.required) ? (s.required as string[]) : [])
  const params = Object.entries(props).map(([k, v]) => {
    const def = v && typeof v === 'object' && v.default !== undefined ? ` =${JSON.stringify(v.default)}` : ''
    return `${k}${req.has(k) ? '' : '?'}: ${typeSig(v, 1)}${def}`
  })
  return `${tool.name}(${params.join(', ')})`
}

/** An options schema as `{size?: 9|13|19 =9, …}` (for a toolset's options). */
export function objectSignature(schema: unknown): string {
  const inner = signature({ name: '', inputSchema: schema }).slice(1, -1)
  return inner ? `{${inner}}` : '{}'
}

/** First sentence of a description, bounded. */
export function firstSentence(text: string | undefined, max = 140): string {
  const t = (text ?? '').trim().replace(/\s+/g, ' ')
  // A sentence ends at . ! ? followed by a capital, a bracket, or the end — so "e.g. \"D4\"" does not end it.
  const m = t.match(/^(.+?[.!?])(?=\s+[A-Z(\[]|$)/)
  const s = m ? m[1]! : t
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj)
    .sort()
    .filter(k => obj[k] !== undefined)
    .map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`
}

/** Identity of a definition as the model reads it (name, description, schema). */
export function toolDigest(tool: ToolDef): string {
  return createHash('sha256')
    .update(canonicalJson({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema ?? null }))
    .digest('base64url')
    .slice(0, 22)
}

/**
 * Tool lines as the model reads them. A definition the model has already been
 * shown gets its signature only; a new or changed one also gets its first
 * sentence. `shown` is updated.
 */
export function renderToolLines(tools: ToolDef[], shown: Set<string>, opts: { describeAll?: boolean; indent?: string } = {}): string[] {
  const indent = opts.indent ?? '  '
  return tools.map(t => {
    const d = toolDigest(t)
    const describe = opts.describeAll || !shown.has(d)
    shown.add(d)
    const sentence = describe ? firstSentence(t.description) : ''
    return `${indent}${signature(t)}${sentence ? ` — ${sentence}` : ''}`
  })
}

/** The full definition, for `look {server, tool}`. */
export function renderToolDefinition(tool: ToolDef): string {
  const cls = tool._meta?.['mcpl/class']
  return [
    signature(tool),
    tool.description ?? '',
    ...(Array.isArray(cls) ? [`class: ${cls.join(', ')}`] : []),
    'inputSchema:',
    JSON.stringify(tool.inputSchema ?? {}, null, 2),
  ]
    .filter(l => l !== '')
    .join('\n')
}
