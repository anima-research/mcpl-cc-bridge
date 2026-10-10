/**
 * MCPL RFC-008 tool classes for the bridge's own tools.
 *
 * A server declares what each tool does as `_meta: { "mcpl/class": [...] }` on
 * its MCP tool definition; a host uses the class as a policy key — e.g. what a
 * tool-lifecycle observer may see (`comms` and unclassed tools never expose
 * arguments). Proxied MCPL tools carry their own server's `_meta` through the
 * bridge unchanged; this map covers only the tools the bridge implements.
 *
 * The rule that matters: a tool whose arguments or result carry people's
 * messages is `comms`, whatever else it also is. Leaving a tool out is safe —
 * an unclassed tool is handled as the most restrictive class — so the
 * dangerous mistake is a non-comms class on a tool that carries messages.
 */

export const CLASS_META_KEY = 'mcpl/class'

export const TOOL_CLASSES = ['comms', 'memory', 'notes', 'files', 'shell', 'web', 'computer', 'media', 'body', 'control'] as const
export type ToolClass = (typeof TOOL_CLASSES)[number]

export const BRIDGE_TOOL_CLASSES: Readonly<Record<string, readonly ToolClass[]>> = {
  // Publishes the agent's text into a channel people read.
  mcpl_send: ['comms'],
  // Subscribes to a channel's traffic; with history_limit > 0 it returns people's messages.
  mcpl_open: ['comms', 'control'],
  mcpl_close: ['control'],
  mcpl_status: ['control'],
  mcpl_reload: ['control'],
}

/** Deliberately unclassed: hosts handle these as the most restrictive class. */
export const UNCLASSED_BRIDGE_TOOLS: ReadonlySet<string> = new Set([
  // Completion text answering a server's inference request; the server may
  // relay it to people or use it any other way, so no class describes it.
  'mcpl_answer',
])

/** The tool with its RFC-008 class declared in `_meta`, if the map has one. */
export function withBridgeClass<T extends { name: string; _meta?: Record<string, unknown> }>(tool: T): T {
  if (!Object.hasOwn(BRIDGE_TOOL_CLASSES, tool.name)) return tool
  return { ...tool, _meta: { ...tool._meta, [CLASS_META_KEY]: [...BRIDGE_TOOL_CLASSES[tool.name]] } }
}
