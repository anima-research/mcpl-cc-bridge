#!/usr/bin/env bun
/**
 * Operator CLI for the bridge's identity (MCPL RFC-015) — deliberately NOT a
 * tool: enrollment and its key material are the operator's business, and
 * nothing here ever reaches a model.
 *
 *   bun run src/identity-cli.ts status [--check <audience>] [--config <path>]
 *   bun run src/identity-cli.ts enroll --invite <code> --name <name> [--config <path>]
 *
 * (or `bun run identity <command> …` from plugins/mcpl-bridge).
 *
 * Reads `identity` from the bridge config: --config, else $MCPL_BRIDGE_CONFIG,
 * $CLAUDE_PROJECT_DIR/.mcpl-bridge.json, ./.mcpl-bridge.json, and
 * ~/.claude/mcpl-bridge/config.json — the bridge's own order, plus the
 * current directory. Never prints a credential, proof or private key.
 */
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { ACCESS_TTL, AccessRefused } from './access'
import { configPath, loadConfig, resolveIdentity } from './config'
import { Identity } from './identity'

function parse(args: string[]): { cmd: string | undefined; flag: Map<string, string> } {
  const flag = new Map<string, string>()
  let cmd: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.startsWith('--')) {
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flag.set(a.slice(2), next)
        i++
      } else flag.set(a.slice(2), 'true')
    } else if (cmd === undefined) cmd = a
    else die(`unexpected argument "${a}"`)
  }
  return { cmd, flag }
}

function die(msg: string): never {
  console.error(`identity: ${msg}`)
  process.exit(1)
}

function findConfig(explicit: string | undefined): string {
  if (explicit) {
    const p = resolve(explicit)
    if (!existsSync(p)) die(`no config at ${p}`)
    return p
  }
  const found = configPath()
  if (found) return found
  const local = join(process.cwd(), '.mcpl-bridge.json')
  if (existsSync(local)) return local
  die('no bridge config found (pass --config <path>)')
}

async function main(): Promise<void> {
  const { cmd, flag } = parse(process.argv.slice(2))
  if (!cmd || cmd === 'help' || flag.has('help')) {
    console.log('usage:\n  identity status [--check <audience>] [--config <path>]\n  identity enroll --invite <code> --name <name> [--config <path>]')
    return
  }
  const path = findConfig(flag.get('config'))
  process.env.MCPL_BRIDGE_CONFIG = path
  const { config } = loadConfig()
  if (!config.identity) die(`${path} has no "identity" — add { "identity": { "home": "id.animalabs.ai" } } first`)
  const id = new Identity(resolveIdentity(config.identity))

  if (cmd === 'status') {
    const rec = id.record()
    console.log(`config   ${path}`)
    console.log(`home     ${id.home}${id.url !== `https://${id.home}` ? ` (at ${id.url})` : ''}`)
    console.log(`key      ${id.keyPath}`)
    console.log(`key id   ${id.keyId()}`)
    console.log(rec ? `enrolled ${rec.sub} ("${rec.name}") with ${rec.home} since ${rec.enrolledAt}` : 'enrolled no — run: identity enroll --invite <code> --name <name>')
    const aud = flag.get('check')
    if (aud && aud !== 'true') {
      // Mints a real (short-lived) credential to prove the path works; shows only its shape.
      try {
        const c = await id.mint(aud, { ttl: ACCESS_TTL })
        const mins = Math.round((c.expiresAt - Date.now()) / 60_000)
        console.log(`check    ${aud}: ok — ${c.principal ?? 'principal unknown'}, expires ${new Date(c.expiresAt).toISOString()} (~${mins} min)`)
      } catch (e) {
        console.log(`check    ${aud}: refused — ${e instanceof AccessRefused ? e.reason : e instanceof Error ? e.message : e}`)
        process.exitCode = 2
      }
    }
    return
  }

  if (cmd === 'enroll') {
    const invite = flag.get('invite') ?? die('--invite <code> required')
    const name = flag.get('name') ?? die('--name <name> required')
    try {
      const rec = await id.enroll(invite, name)
      console.log(`enrolled ${rec.sub} ("${rec.name}") with ${rec.home}`)
      console.log(`key id   ${id.keyId()}`)
      console.log(`record   ${id.recordPath}`)
    } catch (e) {
      die(e instanceof Error ? e.message : String(e))
    }
    return
  }

  die(`unknown command "${cmd}" — status | enroll`)
}

await main()
