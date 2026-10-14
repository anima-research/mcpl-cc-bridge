/**
 * File references in tool arguments.
 *
 * A tool argument may point at a local file instead of carrying its contents:
 *   "$file:/abs/path"            the file's text (UTF-8)
 *   "$file:/abs/path;base64"     the file's bytes, base64
 *   { "$file": "/abs/path", "encoding": "utf8" | "base64" }
 * The bridge swaps the contents in before the call leaves, so a 1 MB page or a
 * 400 KB data file never passes through the model's context. Only files under
 * the allowed roots (the project directory, the session scratchpad, the bridge's
 * working directory, and any `files.roots` from the config) can be read, and
 * one call may read at most `maxBytes` in total.
 */
import { promises as fs } from 'fs'
import { isAbsolute, resolve, sep } from 'path'

export type FileArgOptions = { roots: string[]; maxBytes: number }

const STRING_REF = /^\$file:(.+?)(;base64)?$/s

export class FileArgError extends Error {}

async function allowedPath(p: string, roots: string[]): Promise<string> {
  if (!isAbsolute(p)) throw new FileArgError(`$file paths must be absolute: ${p}`)
  let real: string
  try { real = await fs.realpath(p) } catch { throw new FileArgError(`$file: no such file: ${p}`) }
  const ok = await Promise.all(roots.map(async r => {
    let rr: string
    try { rr = await fs.realpath(r) } catch { return false }
    return real === rr || real.startsWith(rr.endsWith(sep) ? rr : rr + sep)
  }))
  if (!ok.some(Boolean)) throw new FileArgError(`$file: ${p} is outside the allowed roots (${roots.join(', ')})`)
  return real
}

/** Replace every $file reference in `args` with the file's contents. Returns the same object when there are none. */
export async function resolveFileArgs(args: Record<string, unknown>, opts: FileArgOptions): Promise<Record<string, unknown>> {
  let total = 0
  let touched = false
  const over = (p: string) => new FileArgError(`$file: ${p} would bring this call over ${Math.round(opts.maxBytes / 1024 / 1024)} MB of file contents`)
  const read = async (p: string, encoding: 'utf8' | 'base64'): Promise<string> => {
    const real = await allowedPath(p, opts.roots)
    const st = await fs.stat(real)
    if (!st.isFile()) throw new FileArgError(`$file: not a file: ${p}`)
    if (total + st.size > opts.maxBytes) throw over(p)
    // Read through an open handle, bounded by what is left of the budget: a file that grows
    // between stat and read cannot carry the call past the cap.
    const budget = opts.maxBytes - total
    const fh = await fs.open(real, 'r')
    let buf: Buffer
    try {
      buf = Buffer.alloc(budget + 1)
      const { bytesRead } = await fh.read(buf, 0, budget + 1, 0)
      if (bytesRead > budget) throw over(p)
      buf = buf.subarray(0, bytesRead)
    } finally { await fh.close() }
    total += buf.length
    touched = true
    return encoding === 'base64' ? buf.toString('base64') : buf.toString('utf8')
  }
  const walk = async (v: unknown): Promise<unknown> => {
    if (typeof v === 'string') {
      const m = STRING_REF.exec(v)
      return m ? read(m[1], m[2] ? 'base64' : 'utf8') : v
    }
    if (Array.isArray(v)) return Promise.all(v.map(walk))
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (typeof o.$file === 'string') {
        const enc = o.encoding === 'base64' ? 'base64' : 'utf8'
        return read(o.$file, enc)
      }
      // A null prototype keeps an own "__proto__" key as data instead of re-pointing the prototype.
      const out: Record<string, unknown> = Object.create(null)
      for (const [k, x] of Object.entries(o)) out[k] = await walk(x)
      return out
    }
    return v
  }
  const out = (await walk(args)) as Record<string, unknown>
  return touched ? out : args
}

/** The roots a bridge process may read $file references from. */
export function defaultFileRoots(extra: string[] = []): string[] {
  const roots = new Set<string>()
  if (process.env.CLAUDE_PROJECT_DIR) roots.add(resolve(process.env.CLAUDE_PROJECT_DIR))
  roots.add(process.cwd())
  // Claude Code's per-session scratchpads live under /private/tmp/claude-<uid>/ (macOS) or /tmp/claude-<uid>/.
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid !== null) { roots.add(`/private/tmp/claude-${uid}`); roots.add(`/tmp/claude-${uid}`) }
  for (const r of extra) roots.add(resolve(r))
  return [...roots]
}
