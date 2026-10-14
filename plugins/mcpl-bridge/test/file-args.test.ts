import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveFileArgs, FileArgError } from '../src/file-args'

const root = mkdtempSync(join(tmpdir(), 'file-args-'))
const other = mkdtempSync(join(tmpdir(), 'file-args-other-'))
mkdirSync(join(root, 'sub'))
writeFileSync(join(root, 'sub', 'page.html'), '<h1>hi</h1>')
writeFileSync(join(root, 'bytes.bin'), Buffer.from([0, 1, 2, 255]))
writeFileSync(join(other, 'secret.txt'), 'nope')
const opts = { roots: [root], maxBytes: 1024 }

test('string and object forms are replaced; everything else is untouched', async () => {
  const out = await resolveFileArgs({ content: `$file:${join(root, 'sub', 'page.html')}`, data: { $file: join(root, 'bytes.bin'), encoding: 'base64' }, title: 'T', n: 3, list: [`$file:${join(root, 'sub', 'page.html')}`, 'plain'] }, opts)
  expect(out.content).toBe('<h1>hi</h1>')
  expect(out.data).toBe(Buffer.from([0, 1, 2, 255]).toString('base64'))
  expect(out.title).toBe('T'); expect(out.n).toBe(3)
  expect(out.list).toEqual(['<h1>hi</h1>', 'plain'])
})

test('the ;base64 suffix on the string form', async () => {
  const out = await resolveFileArgs({ b: `$file:${join(root, 'bytes.bin')};base64` }, opts)
  expect(out.b).toBe('AAEC/w==')
})

test('no references: the same object comes back', async () => {
  const args = { a: 'x', b: { c: 1 } }
  expect(await resolveFileArgs(args, opts)).toBe(args)
})

test('outside the roots, relative, missing, and over the cap are refused', async () => {
  await expect(resolveFileArgs({ a: `$file:${join(other, 'secret.txt')}` }, opts)).rejects.toBeInstanceOf(FileArgError)
  await expect(resolveFileArgs({ a: '$file:sub/page.html' }, opts)).rejects.toBeInstanceOf(FileArgError)
  await expect(resolveFileArgs({ a: `$file:${join(root, 'nope.txt')}` }, opts)).rejects.toBeInstanceOf(FileArgError)
  await expect(resolveFileArgs({ a: `$file:${join(root, 'sub', 'page.html')}` }, { roots: [root], maxBytes: 4 })).rejects.toBeInstanceOf(FileArgError)
})

test('a "__proto__" key survives the copy as data', async () => {
  const args = JSON.parse(`{"a": "$file:${join(root, 'sub', 'page.html')}", "payload": {"__proto__": {"x": 1}, "k": 2}}`)
  const out = (await resolveFileArgs(args, opts)) as any
  expect(JSON.stringify(out.payload)).toBe('{"__proto__":{"x":1},"k":2}')
  expect(out.payload.x).toBeUndefined()
})

test('the cap counts bytes actually read, and a file at exactly the cap passes', async () => {
  const big = join(root, 'big.txt')
  writeFileSync(big, 'x'.repeat(100))
  expect(((await resolveFileArgs({ a: `$file:${big}` }, { roots: [root], maxBytes: 100 })) as any).a.length).toBe(100)
  await expect(resolveFileArgs({ a: `$file:${big}`, b: `$file:${big}` }, { roots: [root], maxBytes: 150 })).rejects.toBeInstanceOf(FileArgError)
})
