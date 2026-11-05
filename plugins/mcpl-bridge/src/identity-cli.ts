#!/usr/bin/env bun
/**
 * Operator CLI for the bridge's identity (MCPL RFC-015) — deliberately NOT a
 * tool: enrollment and its key material are the operator's business, and
 * nothing here ever reaches a model.
 *
 *   bun run src/identity-cli.ts status [--check <audience>] [--config <path>]
 *   bun run src/identity-cli.ts enroll --invite <code> --name <name> [--config <path>]
 *   bun run src/identity-cli.ts adopt [--only <server,server>] [--config <path>]
 *
 * (or `bun run identity <command> …` from plugins/mcpl-bridge).
 *
 * Reads `identity` from the bridge config: --config, else $MCPL_BRIDGE_CONFIG,
 * $CLAUDE_PROJECT_DIR/.mcpl-bridge.json, ./.mcpl-bridge.json, and
 * ~/.claude/mcpl-bridge/config.json — the bridge's own order, plus the
 * current directory. Never prints a credential, proof or private key.
 */
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { ACCESS_TTL, AccessRefused, rfc3339 } from './access'
import { adoptTokens, type RawConfig } from './adopt'
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
    console.log('usage:\n  identity status [--check <audience>] [--config <path>]\n  identity enroll --invite <code> --name <name> [--config <path>]\n  identity adopt [--only <server,server>] [--config <path>]')
    return
  }
  const path = findConfig(flag.get('config'))
  process.env.MCPL_BRIDGE_CONFIG = path
  const { config } = loadConfig()
  if (cmd === 'adopt') return adopt(path, flag.get('only')?.split(','))
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
        console.log(`check    ${aud}: ok — ${c.principal ?? 'principal unknown'}, expires ${rfc3339(c.expiresAt)} (~${mins} min)`)
      } catch (e) {
        console.log(`check    ${aud}: refused — ${e instanceof AccessRefused ? `${e.reason} (${e.kind})` : e instanceof Error ? e.message : e}`)
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

  die(`unknown command "${cmd}" — status | enroll | adopt`)
}

/**
 * Move servers from static aid1 tokens to self-renewing access. The config is
 * rewritten only if something moved and the file has not changed meanwhile: a
 * 0600 backup first (it holds the old tokens), then an atomic replace that
 * keeps the file's mode. A running bridge picks it up on its own.
 */
async function adopt(path: string, only: string[] | undefined): Promise<void> {
  const original = readFileSync(path, 'utf8')
  const raw = JSON.parse(original) as RawConfig
  const results = await adoptTokens(raw, { makeIdentity: c => new Identity(resolveIdentity(c)), ...(only ? { only } : {}) })
  if (!results.length) {
    console.log(`${path}: no server here dials with a static aid1 token${only ? ` among ${only.join(', ')}` : ''}`)
    return
  }
  if (!results.some(r => r.outcome === 'adopted')) {
    for (const r of results) console.log(r.detail)
    process.exitCode = 2
    return
  }
  // The issuer calls took a while: what was read must still be what is there, or this would undo someone's edit.
  if (readFileSync(path, 'utf8') !== original) {
    console.log(`${path} changed while this ran: nothing written. Run this again.`)
    process.exitCode = 2
    return
  }
  for (const r of results) console.log(r.detail)
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const backup = `${path}.bak-pre-adopt-${stamp}`
  copyFileSync(path, backup)
  chmodSync(backup, 0o600)
  const mode = statSync(path).mode & 0o777
  writeFileSync(`${path}.tmp`, JSON.stringify(raw, null, 2) + '\n', { mode })
  chmodSync(`${path}.tmp`, mode)
  renameSync(`${path}.tmp`, path)
  console.log(`wrote ${path}\nbackup ${backup} (holds the old tokens)`)
  if (results.some(r => r.outcome === 'kept')) process.exitCode = 2
}

await main()
