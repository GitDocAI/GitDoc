// End-to-end tests of the assembled engine (run `npm run build` first).
// They start the real server, publish through its HTTP API and read pages back.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { request } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ENGINE = resolve('engine')
const TOKEN = 'test-token'
const tmp = () => mkdtempSync(join(tmpdir(), 'gitdoc-engine-'))
const cleanup = []

if (!existsSync(join(ENGINE, 'server/entry.mjs'))) {
  throw new Error('engine/ is missing: run `npm run build` first')
}

function freePort() {
  return new Promise((ok) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => ok(p))
    })
  })
}

async function startServer({ dir = ENGINE, env = {} } = {}) {
  const port = await freePort()
  const data = tmp()
  const child = spawn(process.execPath, [join(dir, 'server/entry.mjs')], {
    env: {
      PATH: process.env.PATH,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: data,
      PUBLISH_TOKEN: TOKEN,
      RENDER_CLI_PATH: join(dir, 'render.js'),
      ...env,
    },
    stdio: 'ignore',
  })
  cleanup.push(() => child.kill())
  for (let i = 0; i < 100; i++) {
    try {
      const r = await http(port, '/login')
      if (r.status) break
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  return { port, data, stop: () => child.kill() }
}

/** `fetch` can't set Host; the server routes sites by it, so use http.request. */
function http(port, path, { host = 'localhost', method = 'GET', headers = {}, body } = {}) {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host, ...headers } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf-8') }))
    })
    req.on('error', fail)
    req.end(body)
  })
}

/** Create a docs folder and return it packed as .tar.gz. */
function makeSite({ name, pages, section = 'Guides' }) {
  const dir = tmp()
  mkdirSync(join(dir, 'v1'), { recursive: true })
  const nav = []
  for (const [slug, title, body] of pages) {
    writeFileSync(join(dir, `v1/${slug}.mdx`), `---\ntitle: ${title}\n---\n\n${body}\n`)
    nav.push(`v1/${slug}`)
  }
  writeFileSync(
    join(dir, 'gitdocai.json'),
    JSON.stringify({
      format: 1,
      name,
      'x-site-key': name.toLowerCase().replace(/\W+/g, '-'),
      versions: [{ name: 'v1', slug: 'v1', default: true, latest: true, navigation: [{ section, pages: nav }] }],
    }),
  )
  const tgz = join(tmp(), 'site.tar.gz')
  execFileSync('tar', ['-czf', tgz, '-C', dir, '.'])
  return readFileSync(tgz)
}

const publish = (port, archive, hostname) =>
  http(port, `/api/publish${hostname ? `?hostname=${hostname}` : ''}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/gzip' },
    body: archive,
  })

after(() => cleanup.forEach((f) => f()))

test('publishing needs the token', async () => {
  const s = await startServer()
  const bad = await http(s.port, '/api/publish', { method: 'POST', headers: { 'content-type': 'application/gzip' }, body: 'x' })
  assert.equal(bad.status, 401)
  const wrong = await http(s.port, '/api/publish', { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/gzip' }, body: 'x' })
  assert.equal(wrong.status, 401)
})

test('a published site is served, with its title shown above the content', async () => {
  const s = await startServer()
  const r = await publish(s.port, makeSite({ name: 'Acme Docs', pages: [['intro', 'Introduction', 'Hello **world**.']] }), 'acme.localhost')
  assert.equal(r.status, 200, r.text)
  const out = JSON.parse(r.text)
  assert.equal(out.result.rendered_pages, 1)

  const page = await http(s.port, '/guides/intro', { host: 'acme.localhost' })
  assert.equal(page.status, 200)
  assert.match(page.text, /<h1[^>]*>Introduction<\/h1>/)
  assert.match(page.text, /<strong>world<\/strong>/)

  const md = await http(s.port, '/guides/intro.md', { host: 'acme.localhost' })
  assert.equal(md.status, 200)
  assert.match(md.headers['content-type'], /markdown/)
})

test('a page that starts with its own heading does not show the title twice', async () => {
  const s = await startServer()
  await publish(s.port, makeSite({ name: 'Dup', pages: [['p', 'Same Title', '# Same Title\n\nBody.']] }), 'dup.localhost')
  const page = await http(s.port, '/guides/p', { host: 'dup.localhost' })
  const article = page.text.match(/<article[\s\S]*?<\/article>/)[0]
  assert.equal((article.match(/<h1\b/g) ?? []).length, 1)
})

test('several sites on one server are told apart by hostname', async () => {
  const s = await startServer()
  await publish(s.port, makeSite({ name: 'Alpha', pages: [['a', 'Alpha page', 'ALPHA_ONLY_TEXT']] }), 'alpha.localhost')
  await publish(s.port, makeSite({ name: 'Beta', pages: [['b', 'Beta page', 'BETA_ONLY_TEXT']] }), 'beta.localhost')

  const a = await http(s.port, '/guides/a', { host: 'alpha.localhost' })
  const b = await http(s.port, '/guides/b', { host: 'beta.localhost' })
  assert.match(a.text, /ALPHA_ONLY_TEXT/)
  assert.doesNotMatch(a.text, /BETA_ONLY_TEXT/)
  assert.match(b.text, /BETA_ONLY_TEXT/)

  // with two sites an unknown host must not fall back to one of them
  const other = await http(s.port, '/guides/a', { host: 'other.example.com' })
  assert.equal(other.status, 404)

  const sites = await http(s.port, '/api/sites', { headers: { authorization: `Bearer ${TOKEN}` } })
  assert.deepEqual(JSON.parse(sites.text).sites.map((x) => x.hostname).sort(), ['alpha.localhost', 'beta.localhost'])
})

test('a private site asks for a login, also under /api/… (regression)', async () => {
  const s = await startServer({ env: { DOCS_PRIVATE: 'true' } })
  // a section whose pages live under /api/…, which used to bypass the gate
  await publish(s.port, makeSite({ name: 'Secret', section: 'API', pages: [['users', 'Users', 'SECRET_TEXT']] }), 'secret.localhost')

  for (const path of ['/api/users', '/api/anything/else']) {
    const r = await http(s.port, path, { host: 'secret.localhost' })
    assert.equal(r.status, 302, `${path} must redirect to login`)
    assert.match(r.headers.location, /^\/login/)
    assert.doesNotMatch(r.text, /SECRET_TEXT/)
  }
  // the API routes that really exist still answer without a redirect
  const search = await http(s.port, '/api/search', { host: 'secret.localhost', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"query":"x"}' })
  assert.notEqual(search.status, 302)
})

test('asset ids cannot be used to read other files', async () => {
  const s = await startServer()
  await publish(s.port, makeSite({ name: 'Safe', pages: [['p', 'P', 'x']] }), 'safe.localhost')
  for (const path of ['/assets/..%2F..%2F_domains%2Findex.json', '/assets/%2e%2e%2f%2e%2e%2fetc%2fpasswd']) {
    const r = await http(s.port, path, { host: 'safe.localhost' })
    assert.equal(r.status, 404)
  }
})

test('the engine runs from any directory, with no node_modules next to it', async () => {
  const copy = join(tmp(), 'somewhere-else')
  cpSync(ENGINE, copy, { recursive: true })
  const s = await startServer({ dir: copy })
  const r = await publish(s.port, makeSite({ name: 'Moved', pages: [['p', 'Moved page', 'works']] }), 'moved.localhost')
  assert.equal(r.status, 200, r.text)
  const page = await http(s.port, '/guides/p', { host: 'moved.localhost' })
  assert.match(page.text, /Moved page/)
})
