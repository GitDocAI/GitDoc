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

// ---------------------------------------------------------------- search ---

const search = (port, host, query, extra = {}) =>
  http(port, '/api/search', {
    host,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, ...extra }),
  }).then((r) => ({ status: r.status, ...JSON.parse(r.text) }))

const GUIDE = [
  ['install', 'Installation', 'Run `npm install gitdoc-cli` to get the command line tool.'],
  ['deploy', 'Deploying', 'Publish the site to your own server with a Docker container.'],
  ['faq', 'Preguntas frecuentes', 'Configuración de dominios y certificados.'],
]

test('search: the embedded backend ranks, highlights and isolates sites', async () => {
  const s = await startServer()
  const r = await publish(s.port, makeSite({ name: 'Find Me', pages: GUIDE }), 'find.localhost')
  assert.equal(r.status, 200, r.text)
  const out = JSON.parse(r.text)
  assert.deepEqual([out.search.backend, out.search.indexed, out.search.semantic], ['embedded', 3, false])

  const hit = await search(s.port, 'find.localhost', 'docker')
  assert.equal(hit.status, 200)
  assert.equal(hit.results[0].path, '/guides/deploy')
  assert.equal(hit.results[0].title, 'Deploying')
  assert.match(hit.results[0].highlights.join(' '), /<mark>Docker<\/mark>/)

  // Title beats body, a prefix matches (search as you type), accents fold.
  assert.equal((await search(s.port, 'find.localhost', 'install')).results[0].path, '/guides/install')
  assert.equal((await search(s.port, 'find.localhost', 'instal')).results[0].path, '/guides/install')
  assert.equal((await search(s.port, 'find.localhost', 'configuracion')).results[0].path, '/guides/faq')
  assert.deepEqual((await search(s.port, 'find.localhost', 'zzzznothing')).results, [])

  // Another site's pages never leak in, and a republish replaces the index.
  await publish(s.port, makeSite({ name: 'Other', pages: [['x', 'Kubernetes', 'Helm chart notes.']] }), 'other.localhost')
  assert.deepEqual((await search(s.port, 'other.localhost', 'docker')).results, [])
  assert.equal((await search(s.port, 'other.localhost', 'helm')).results.length, 1)
  await publish(s.port, makeSite({ name: 'Find Me', pages: [['only', 'Only page', 'Nothing about containers.']] }), 'find.localhost')
  assert.deepEqual((await search(s.port, 'find.localhost', 'docker')).results, [])

  assert.equal((await http(s.port, '/api/search', { host: 'find.localhost', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400)
})

/** A stand-in OpenSearch (and OpenAI-style embeddings endpoint) that records what it is sent. */
async function fakeOpenSearch({ dim = 0 } = {}) {
  const { createServer: srv } = await import('node:http')
  const seen = []
  const indices = new Set()
  const server = srv((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8')
      const url = req.url
      seen.push({ method: req.method, url, auth: req.headers.authorization, raw })
      const send = (code, body = {}) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (url === '/embeddings') {
        const { input } = JSON.parse(raw)
        return send(200, { data: input.map((_, index) => ({ index, embedding: Array.from({ length: dim }, (_, i) => (i + 1) / dim) })) })
      }
      const idx = url.split('?')[0].split('/')[1]
      if (req.method === 'HEAD') return send(indices.has(idx) ? 200 : 404)
      if (req.method === 'PUT') return indices.add(idx), send(200, { acknowledged: true })
      if (url === '/_bulk') return send(200, { errors: false, items: [] })
      if (url.endsWith('/_search')) {
        return send(200, {
          hits: {
            hits: [
              {
                _score: 3.5,
                _source: { entry_id: 'e1', section_id: 's1', version_id: 'v1', path: '/guides/deploy', title: 'Deploying' },
                highlight: { content: ['run <mark>docker</mark>'] },
              },
            ],
          },
        })
      }
      send(200, {})
    })
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  cleanup.push(() => server.close())
  return { url: `http://127.0.0.1:${server.address().port}`, seen }
}

test('search: the OpenSearch adapter writes and queries the hosted index shape', async () => {
  const os = await fakeOpenSearch()
  const s = await startServer({ env: { OPENSEARCH_URL: os.url, OPENSEARCH_USERNAME: 'admin', OPENSEARCH_PASSWORD: 'pw' } })
  const r = await publish(s.port, makeSite({ name: 'Os Site', pages: GUIDE }), 'os.localhost')
  const out = JSON.parse(r.text)
  assert.deepEqual([out.search.backend, out.search.indexed, out.search.semantic], ['opensearch', 3, false], r.text)

  const put = os.seen.find((x) => x.method === 'PUT')
  assert.match(put.url, /^\/doc_[\w-]+_[\w-]+$/) // doc_{org}_{doc}
  const mapping = JSON.parse(put.raw)
  assert.equal(mapping.mappings.properties.doc_type.type, 'keyword')
  assert.equal(mapping.mappings.properties.doc_embedding, undefined) // text-only: no vectors configured
  assert.equal(put.auth, 'Basic ' + Buffer.from('admin:pw').toString('base64'))

  const bulk = os.seen.find((x) => x.url === '/_bulk').raw.trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(bulk[0].index._index, put.url.slice(1))
  assert.equal(bulk[1].doc_type, 'doc_entry')
  assert.equal(bulk[1].path, '/guides/install')
  assert.ok(!bulk[1].content.includes('`'), 'content is plain text')
  assert.ok(os.seen.some((x) => x.url.includes('_delete_by_query')), 'stale pages are removed after the upsert')

  const found = await search(s.port, 'os.localhost', 'docker', { limit: 5 })
  assert.deepEqual(found.results[0], {
    version_id: 'v1', section_id: 's1', entry_id: 'e1', path: '/guides/deploy', title: 'Deploying',
    highlights: ['run <mark>docker</mark>'], score: 3.5,
  })
  const q = JSON.parse(os.seen.filter((x) => x.url.endsWith('/_search')).at(-1).raw)
  assert.equal(q.size, 5)
  assert.equal(q.query.bool.should[0].match.title.boost, 2)
  assert.equal(q.query.bool.should.length, 2) // no knn clause without embeddings
})

test('search: with an embeddings endpoint the index gets vectors and queries use knn', async () => {
  const os = await fakeOpenSearch({ dim: 8 })
  const s = await startServer({ env: { OPENSEARCH_URL: os.url, EMBEDDINGS_URL: os.url, EMBEDDINGS_MODEL: 'test-model' } })
  const out = JSON.parse((await publish(s.port, makeSite({ name: 'Vec Site', pages: GUIDE }), 'vec.localhost')).text)
  assert.equal(out.search.semantic, true, JSON.stringify(out.search))

  const mapping = JSON.parse(os.seen.find((x) => x.method === 'PUT').raw)
  assert.equal(mapping.mappings.properties.doc_embedding.type, 'knn_vector')
  assert.equal(mapping.mappings.properties.doc_embedding.dimension, 8)
  const doc = JSON.parse(os.seen.find((x) => x.url === '/_bulk').raw.trim().split('\n')[1])
  assert.equal(doc.doc_embedding.length, 8)

  await search(s.port, 'vec.localhost', 'anything')
  const q = JSON.parse(os.seen.filter((x) => x.url.endsWith('/_search')).at(-1).raw)
  assert.equal(q.query.bool.should.at(-1).knn.doc_embedding.k, 10)
})

test('search: an unreachable OpenSearch degrades search, not the publish', async () => {
  const s = await startServer({ env: { SEARCH_BACKEND: 'opensearch', OPENSEARCH_URL: 'http://127.0.0.1:9' } })
  const r = await publish(s.port, makeSite({ name: 'Down', pages: GUIDE }), 'down.localhost')
  assert.equal(r.status, 200)
  assert.ok(JSON.parse(r.text).search.error)
  assert.equal((await http(s.port, '/guides/install', { host: 'down.localhost' })).status, 200)
  assert.equal((await search(s.port, 'down.localhost', 'docker')).status, 503)
})

// Against a real cluster, e.g.:
//   docker run -d -p 9200:9200 -e discovery.type=single-node -e DISABLE_SECURITY_PLUGIN=true \
//     -e DISABLE_INSTALL_DEMO_CONFIG=true opensearchproject/opensearch:2.19.1
//   GITDOC_TEST_OPENSEARCH_URL=http://127.0.0.1:9200 npm test
test('search: against a real OpenSearch', { skip: !process.env.GITDOC_TEST_OPENSEARCH_URL }, async () => {
  const url = process.env.GITDOC_TEST_OPENSEARCH_URL
  const s = await startServer({ env: { OPENSEARCH_URL: url } })
  const name = `Real ${Date.now()}`
  const host = `real-${Date.now()}.localhost`
  const out = JSON.parse((await publish(s.port, makeSite({ name, pages: GUIDE }), host)).text)
  assert.deepEqual([out.search.backend, out.search.indexed, out.search.error], ['opensearch', 3, undefined], JSON.stringify(out))

  const hit = await search(s.port, host, 'docker')
  assert.equal(hit.status, 200, JSON.stringify(hit))
  assert.equal(hit.results[0].path, '/guides/deploy')
  assert.match(hit.results[0].highlights.join(' '), /<mark>Docker<\/mark>/i)

  // Republishing a smaller site removes the pages that are gone.
  await publish(s.port, makeSite({ name, pages: [GUIDE[0]] }), host)
  const after = await search(s.port, host, 'docker')
  assert.deepEqual(after.results, [])
  assert.equal((await search(s.port, host, 'installation')).results.length, 1)
})

test('search: real OpenSearch with vectors (knn mapping and query)', { skip: !process.env.GITDOC_TEST_OPENSEARCH_URL }, async () => {
  const emb = await fakeOpenSearch({ dim: 8 }) // only its /embeddings is used
  const s = await startServer({ env: { OPENSEARCH_URL: process.env.GITDOC_TEST_OPENSEARCH_URL, EMBEDDINGS_URL: emb.url } })
  const host = `knn-${Date.now()}.localhost`
  const out = JSON.parse((await publish(s.port, makeSite({ name: `Knn ${Date.now()}`, pages: GUIDE }), host)).text)
  assert.equal(out.search.semantic, true, JSON.stringify(out))
  const hit = await search(s.port, host, 'docker')
  assert.equal(hit.status, 200, JSON.stringify(hit))
  assert.ok(hit.results.length >= 1)
})
