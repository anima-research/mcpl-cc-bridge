/**
 * MCPL RFC-015 end to end against a REAL local archipelago-home issuer.
 *
 * Opt-in: set MCPL_ACCESS_E2E_ISSUER to an archipelago-home checkout that has
 * the token-ttl change (POST /token `ttl`), with its dev deps installed; node
 * (>= 22) is taken from MCPL_ACCESS_E2E_NODE or PATH. The test runs `hn serve`
 * on a free loopback port with temporary config and data dirs (under
 * $MCPL_TEST_TMP or the OS tmpdir), mints an invite with `hn invite`, enrolls
 * a test principal with the bridge's own Identity, and kills the issuer by
 * pid at the end. Nothing outside those temp dirs is touched.
 *
 *   MCPL_ACCESS_E2E_ISSUER=~/src/archipelago-home bun test test/access-e2e.test.ts
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccessAuditRecord } from '../src/access'
import { Identity, type IdentityRecord } from '../src/identity'
import { McplServerHandle } from '../src/mcpl-host'
import { McplPeer } from './mcpl-peer'

const ISSUER_DIR = process.env.MCPL_ACCESS_E2E_ISSUER
const NODE = process.env.MCPL_ACCESS_E2E_NODE ?? 'node'
const HOME = 'id.e2e.invalid'
const ROOT = join(import.meta.dir, '..')
const e2e = test.skipIf(!ISSUER_DIR)
if (!ISSUER_DIR) console.error('access-e2e: skipped (set MCPL_ACCESS_E2E_ISSUER to an archipelago-home checkout)')

type Verify = (token: string, opts: { issuerId: string; iss: string; aud: string }) =>
  { ok: true; payload: { aud: string; sub: string; iat: number; exp: number } } | { ok: false; reason: string }

let base = ''
let issuer: ChildProcess | null = null
let issuerUrl = ''
let issuerId = ''
let verifyToken: Verify
let identity: Identity
let rec: IdentityRecord
const peers: McplPeer[] = []
const handles: McplServerHandle[] = []

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

beforeAll(async () => {
  if (!ISSUER_DIR) return
  base = mkdtempSync(join(process.env.MCPL_TEST_TMP ?? tmpdir(), 'mcpl-access-e2e-'))
  const dataDir = join(base, 'issuer-data')
  const configDir = join(base, 'issuer-config')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'audiences.json'), JSON.stringify({ games: { redirect: 'https://games.invalid/auth' }, orrery: { redirect: 'https://orrery.invalid/auth' } }))
  const port = await freePort()
  issuerUrl = `http://127.0.0.1:${port}`
  const env = { ...process.env, HN_DOMAIN: HOME, HN_PUBLIC_URL: issuerUrl, HN_BIND: '127.0.0.1', HN_PORT: String(port), HN_DATA_DIR: dataDir, HN_CONFIG_DIR: configDir }
  // The invite exists before the server starts (its invite store polls the file every 3 s).
  const invite = execFileSync(NODE, ['--import', 'tsx', 'src/cli.ts', 'invite', '--scopes', 'games:play', '--aud', 'games', '--max-uses', '1', '--label', 'mcpl-bridge-e2e'], { cwd: ISSUER_DIR, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  expect(invite).toMatch(/^inv_/)
  issuer = spawn(NODE, ['--import', 'tsx', 'src/cli.ts', 'serve'], { cwd: ISSUER_DIR, env, stdio: ['ignore', 'ignore', 'pipe'] })
  issuer.stderr?.on('data', d => process.env.MCPL_E2E_VERBOSE && process.stderr.write(`  issuer| ${d}`))
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${issuerUrl}/healthz`)).ok) break
    } catch {}
    if (i > 100) throw new Error('local issuer did not come up')
    await sleep(100)
  }
  issuerId = ((await (await fetch(`${issuerUrl}/.well-known/mcpl-identity`)).json()) as { publicKey: string }).publicKey
  verifyToken = ((await import(join(ISSUER_DIR, 'src', 'token.ts'))) as { verifyToken: Verify }).verifyToken
  identity = new Identity({ home: HOME, keyPath: join(base, 'bridge', 'identity-key.pem'), url: issuerUrl })
  rec = await identity.enroll(invite, 'cc-bridge-e2e')
}, 30_000)

afterAll(async () => {
  for (const h of handles) await h.close()
  for (const p of peers) await p.close()
  if (issuer?.pid) {
    const gone = new Promise(r => issuer!.once('exit', r))
    process.kill(issuer.pid, 'SIGTERM') // by pid: only the issuer this test started
    await Promise.race([gone, sleep(3000)])
  }
  if (base) rmSync(base, { recursive: true, force: true })
})

const APPS = { version: '0.5', pushEvents: true, access: { token: true }, featureSets: { apps: { description: 'apps acting as the agent', uses: ['pushEvents', 'access.token'] } } }

function verifyGames(token: string | null) {
  const v = verifyToken(String(token), { issuerId, iss: HOME, aud: 'games' })
  if (!v.ok) throw new Error(`token did not verify: ${v.reason}`)
  return v.payload
}

async function connect(grant: string[], transport: { access?: string } = {}, peerOpts: Parameters<typeof McplPeer.start>[0] = {}) {
  const peer = await McplPeer.start({ mcpl: APPS, ...peerOpts })
  peers.push(peer)
  const audits: AccessAuditRecord[] = []
  const h = new McplServerHandle('apps', { transport: { url: peer.url, ...transport }, grant, reconnectIntervalMs: 200 }, {
    deliver() {},
    toolsChanged() {},
    log: () => {},
    issuer: () => identity,
    audit: r => audits.push(r),
  })
  handles.push(h)
  h.start()
  await h.firstAttempt
  return { peer, h, audits }
}

e2e('a server granted access.token gets a credential for "games" that verifies with the issuer key and expires in ~15 minutes', async () => {
  const { peer, audits } = await connect(['pushEvents', 'access.token'])
  await peer.policyCount(1)
  const r = await peer.request('access/token', { audience: 'games', endpoint: 'wss://games.invalid/mcpl', purpose: 'doom-1: opened by the agent' })
  expect(r.error).toBeUndefined()
  const res = r.result as { scheme: string; credential: string; expiresAt: string; principal: string }
  expect(res.scheme).toBe('bearer')
  const p = verifyGames(res.credential)
  expect(p.aud).toBe('games')
  expect(p.sub).toBe(rec.sub)
  expect(res.principal).toBe(rec.sub)
  expect(p.exp - p.iat).toBe(15 * 60)
  expect(res.expiresAt).toBe(new Date(p.exp * 1000).toISOString())
  const left = p.exp * 1000 - Date.now()
  expect(left).toBeGreaterThan(14 * 60_000)
  expect(left).toBeLessThanOrEqual(15 * 60_000)
  expect(audits[0]).toMatchObject({ kind: 'request', audience: 'games', outcome: 'granted', principal: rec.sub, expiresAt: res.expiresAt })
  expect(JSON.stringify(audits)).not.toContain(res.credential)
})

e2e('without the grant: -32002, and the issuer is never asked', async () => {
  const before = readFileSync(join(base, 'issuer-data', 'minted.jsonl'), 'utf8').split('\n').length
  const { peer } = await connect(['pushEvents'])
  await peer.policyCount(1)
  const r = await peer.request('access/token', { audience: 'games' })
  expect(r.error).toMatchObject({ code: -32002, data: { capability: 'access.token' } })
  expect(readFileSync(join(base, 'issuer-data', 'minted.jsonl'), 'utf8').split('\n').length).toBe(before)
})

e2e('an audience the principal lacks: -32040 carrying the issuer\'s reason', async () => {
  const { peer } = await connect(['pushEvents', 'access.token'])
  await peer.policyCount(1)
  const r = await peer.request('access/token', { audience: 'orrery' })
  expect(r.result).toBeUndefined()
  expect(r.error).toMatchObject({ code: -32040, data: { audience: 'orrery', reason: `${HOME} refused: audience not allowed` } })
  const u = await peer.request('access/token', { audience: 'no-such-service' })
  expect(u.error).toMatchObject({ code: -32040, data: { audience: 'no-such-service', reason: `${HOME} refused: unknown audience` } })
})

e2e('transport.access: a fresh, valid token at the upgrade — on connect, on a forced reconnect, and on a server-side drop', async () => {
  // The peer plays a real audience: it accepts the upgrade only with a valid games token.
  const verifyUpgrade = (url: URL) => (verifyToken(String(url.searchParams.get('token')), { issuerId, iss: HOME, aud: 'games' }).ok ? (true as const) : 401)
  const { peer, h, audits } = await connect(['pushEvents'], { access: 'games' }, { verifyUpgrade })
  await peer.policyCount(1)
  expect(h.status).toBe('ready')
  const t0 = peer.token(0)
  const p0 = verifyGames(t0)
  expect(p0.exp - p0.iat).toBe(15 * 60)

  await sleep(1100) // a new second, so a new mint is a different token
  await h.restart()
  await peer.policyCount(2)
  const t1 = peer.token(1)
  verifyGames(t1)
  expect(t1).not.toBe(t0)

  await sleep(1100)
  peer.dropAll()
  await peer.policyCount(3, 10_000)
  const t2 = peer.token(2)
  verifyGames(t2)
  expect(t2).not.toBe(t1)
  expect(audits.filter(a => a.kind === 'dial' && a.outcome === 'granted')).toHaveLength(3)
  expect(JSON.stringify(audits)).not.toContain(String(t0))

  // An audience this principal cannot obtain: the dial fails, naming it and why, never dialing.
  const bad = await connect(['pushEvents'], { access: 'orrery' })
  expect(bad.h.status).toBe('disconnected')
  expect(bad.h.lastError).toBe(`connect failed: access "orrery": ${HOME} refused: audience not allowed`)
  expect(bad.peer.upgrades).toHaveLength(0)
}, 20_000)

// ── the whole adapter: config → identity → dial + access/token, and nothing reaches the model ──

e2e('adapter: identity from config, access dial and access/token work, and no credential reaches tool results, notifications, status, logs or the audit', async () => {
  const verifyUpgrade = (url: URL) => (verifyToken(String(url.searchParams.get('token')), { issuerId, iss: HOME, aud: 'games' }).ok ? (true as const) : 401)
  let leak = ''
  const peer = await McplPeer.start({
    mcpl: APPS,
    verifyUpgrade,
    tools: [{ name: 'leak', description: 'returns what it holds', inputSchema: { type: 'object', properties: {} } }],
    onToolCall: () => ({ content: [{ type: 'text', text: `holding ${leak} and ${peer.token()}` }] }),
  })
  peers.push(peer)
  const ccDir = join(base, 'cc-config')
  mkdirSync(ccDir, { recursive: true })
  const cfgPath = join(base, 'bridge.json')
  writeFileSync(cfgPath, JSON.stringify({
    identity: { home: HOME, keyPath: identity.keyPath, url: issuerUrl },
    servers: { apps: { transport: { url: peer.url, access: 'games' }, grant: ['tools', 'pushEvents', 'access.token'] } },
  }))
  const child = spawn('bun', ['run', 'src/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, MCPL_BRIDGE_CONFIG: cfgPath, CLAUDE_CONFIG_DIR: ccDir, CLAUDE_CODE_SESSION_ID: `access-e2e-${process.pid}`, MCPL_BRIDGE_WATCH: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  const waiters: Array<{ match: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }> = []
  let buf = ''
  child.stdout.on('data', (d: Buffer) => {
    stdout += d.toString()
    buf += d.toString()
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      const m = JSON.parse(line) as Record<string, unknown>
      for (const w of [...waiters]) if (w.match(m)) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve(m)
      }
    }
  })
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
  const next = (match: (m: Record<string, unknown>) => boolean, ms = 10_000) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`adapter: nothing matched within ${ms}ms\n${stderr.slice(-2000)}`)), ms)
      waiters.push({ match, resolve: m => (clearTimeout(t), resolve(m)) })
    })
  let seq = 0
  const call = async (method: string, params: unknown) => {
    const id = ++seq
    const p = next(m => m.id === id)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return (await p).result as Record<string, unknown>
  }
  try {
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'access-e2e', version: '0' } })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    await peer.policyCount(1, 15_000)
    const dialToken = String(peer.token(0))
    verifyGames(dialToken)

    const r = await peer.request('access/token', { audience: 'games', purpose: 'adapter e2e' })
    leak = (r.result as { credential: string }).credential
    verifyGames(leak)

    // A misbehaving server puts the credential in an event and a tool result (RFC-015 §6.2 forbids it; the host still won't show it).
    const pushed = next(m => m.method === 'notifications/claude/channel')
    peer.request('push/event', { featureSet: 'apps', eventId: 'e1', timestamp: new Date().toISOString(), payload: { content: [{ type: 'text', text: `event carrying ${leak}` }] } }).catch(() => {})
    const note = (await pushed).params as { content: string; meta: Record<string, string> }
    expect(note.content).toBe('event carrying [redacted credential]')

    const tools = (await call('tools/list', {})).tools as Array<{ name: string }>
    expect(tools.map(t => t.name)).toContain('apps__leak')
    const leaked = await call('tools/call', { name: 'apps__leak', arguments: {} })
    expect(JSON.stringify(leaked)).toContain('holding [redacted credential] and [redacted credential]')

    const status = ((await call('tools/call', { name: 'mcpl_status', arguments: {} })).content as Array<{ text: string }>)[0]!.text
    expect(status).toContain('access=games')
    expect(status).toContain('access.token')
    expect(status).toContain(`identity: ${HOME} — enrolled as ${rec.sub}`)
  } finally {
    child.stdin.end()
    await Promise.race([new Promise(r => child.once('exit', r)), sleep(3000)])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  // The recorded session, syntactically (RFC-015 §12 vector 6, host side): neither credential anywhere.
  const audit = readFileSync(join(ccDir, 'mcpl-bridge', 'access-audit.jsonl'), 'utf8')
  const debug = readFileSync(join(ccDir, 'mcpl-bridge', 'debug.log'), 'utf8')
  for (const secret of [leak, String(peer.token(0))]) {
    expect(secret.length).toBeGreaterThan(40)
    for (const [where, text] of [['stdout', stdout], ['stderr', stderr], ['audit', audit], ['debug.log', debug]] as const) {
      if (text.includes(secret)) throw new Error(`credential leaked into ${where}`)
    }
  }
  const lines = audit.trim().split('\n').map(l => JSON.parse(l) as AccessAuditRecord)
  expect(lines.map(l => [l.kind, l.audience, l.outcome])).toEqual([
    ['dial', 'games', 'granted'],
    ['request', 'games', 'granted'],
  ])
  expect(lines[1]).toMatchObject({ server: 'apps', purpose: 'adapter e2e', principal: rec.sub })
  expect(existsSync(join(ccDir, 'mcpl-bridge', `sock-access-e2e-${process.pid}.sock`))).toBe(false)
}, 40_000)
