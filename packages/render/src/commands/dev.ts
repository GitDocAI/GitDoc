import { createServer, type ServerResponse } from 'node:http'
import { existsSync, watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { renderEntry } from '../render/renderEntry'
import type { DocEntryLike } from '../types'

/**
 * `gitdoc-render dev [dir] [--port N]` — local preview of a docs-as-code
 * folder (the packages/docstore layout):
 *
 *   gitdocai.json         manifest: versions → navigation (sections/groups/pages)
 *   <path>.mdx | .md      one page per file, optional YAML front matter
 *   assets/…              files the pages reference
 *
 * Every request re-reads the files from disk, so there is no cache to
 * invalidate: a file watcher only has to tell the browser to reload.
 */

// --- manifest ---------------------------------------------------------

type NavNode = string | { page?: string; group?: string; slug?: string; icon?: string; pages?: NavNode[] }
interface NavSection { section?: string; name?: string; slug?: string; pages?: NavNode[] }
interface BackupPage {
  id: string
  parent_id?: string
  title?: string
  slug?: string
  type?: string
  order?: number
  content_path?: string
}
interface BackupSection { name?: string; slug?: string; visible?: boolean; order?: number; pages?: BackupPage[] }
interface NavVersion {
  name?: string
  slug?: string
  default?: boolean
  is_default?: boolean
  navigation?: NavSection[]
  /** Backup/manifest format (id-based, `content_path` per page). */
  sections?: BackupSection[]
}
interface Manifest { name?: string; description?: string; versions?: NavVersion[] }

interface SidebarItem {
  title: string
  href?: string
  children: SidebarItem[]
}
interface Route {
  path: string // page file path, no extension
  url: string
  sectionSlug: string
}
interface Site {
  manifest: Manifest
  version: NavVersion
  versionPrefix: string
  routes: Map<string, Route>
  sidebar: SidebarItem[]
  versions: { name: string; href: string }[]
}

function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

async function readManifest(dir: string): Promise<Manifest> {
  const file = join(dir, 'gitdocai.json')
  if (!existsSync(file)) {
    throw new Error(`gitdocai.json not found in ${dir}. Run from a docs folder or pass its path.`)
  }
  try {
    return JSON.parse(await readFile(file, 'utf-8')) as Manifest
  } catch (err) {
    throw new Error(`gitdocai.json is not valid JSON: ${(err as Error).message}`)
  }
}

async function buildSite(dir: string, requestPath: string): Promise<Site> {
  const manifest = await readManifest(dir)
  const versions = manifest.versions ?? []
  const def = versions.find((v) => v.default || v.is_default) ?? versions[0]
  if (!def) throw new Error('gitdocai.json has no versions')

  // `/<version-slug>/…` selects a non-default version; the default one
  // lives at the root, same as publish-web.
  const first = requestPath.split('/').filter(Boolean)[0]
  const byPrefix = versions.find((v) => v !== def && v.slug && v.slug === first)
  const version = byPrefix ?? def
  const versionPrefix = byPrefix ? `/${byPrefix.slug}` : ''

  const routes = new Map<string, Route>()
  const titleOf = async (path: string, fallback: string) =>
    (await readPage(dir, path))?.meta.title || fallback

  const walk = async (nodes: NavNode[], sectionSlug: string, trail: string[]): Promise<SidebarItem[]> => {
    const out: SidebarItem[] = []
    for (const n of nodes) {
      if (typeof n === 'string' || (n.page && !n.group)) {
        const path = typeof n === 'string' ? n : (n.page as string)
        const slug = (typeof n === 'object' && n.slug) || path.split('/').pop() || path
        const url = versionPrefix + '/' + [sectionSlug, ...trail, slug].join('/')
        routes.set(url, { path, url, sectionSlug })
        out.push({ title: await titleOf(path, slug), href: url, children: [] })
      } else if (n.group) {
        const slug = n.slug || slugify(n.group)
        const children = await walk(n.pages ?? [], sectionSlug, [...trail, slug])
        const item: SidebarItem = { title: n.group, children }
        if (n.page) {
          const url = versionPrefix + '/' + [sectionSlug, ...trail, slug].join('/')
          routes.set(url, { path: n.page, url, sectionSlug })
          item.href = url
          item.title = await titleOf(n.page, n.group)
        }
        out.push(item)
      }
    }
    return out
  }

  const sidebar: SidebarItem[] = []

  // Backup format: flat pages linked by parent_id, each with its own slug
  // and content_path. URL = section slug + ancestor slugs + page slug.
  const byOrder = (a: BackupPage, b: BackupPage) => (a.order ?? 0) - (b.order ?? 0)
  const backupTree = async (pages: BackupPage[], sectionSlug: string, parent?: string, trail: string[] = []): Promise<SidebarItem[]> => {
    const out: SidebarItem[] = []
    for (const p of pages.filter((x) => (x.parent_id || undefined) === parent).sort(byOrder)) {
      const slug = p.slug || slugify(p.title ?? p.id)
      const url = versionPrefix + '/' + [sectionSlug, ...trail, slug].join('/')
      const hasFile = !!p.content_path && existsSync(join(dir, p.content_path))
      const item: SidebarItem = {
        title: p.title || slug,
        children: await backupTree(pages, sectionSlug, p.id, [...trail, slug]),
      }
      if (hasFile && (p.type !== 'folder' || (await fileHasBody(dir, p.content_path as string)))) {
        routes.set(url, { path: (p.content_path as string).replace(/\.mdx?$/, ''), url, sectionSlug })
        item.href = url
      }
      out.push(item)
    }
    return out
  }
  for (const sec of [...(version.sections ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    if (sec.visible === false) continue
    const slug = sec.slug || slugify(sec.name ?? 'docs')
    sidebar.push({ title: sec.name ?? slug, children: await backupTree(sec.pages ?? [], slug) })
  }

  for (const s of version.navigation ?? []) {
    const name = s.section ?? s.name ?? 'Docs'
    const slug = s.slug || slugify(name)
    sidebar.push({ title: name, children: await walk(s.pages ?? [], slug, []) })
  }

  return {
    manifest,
    version,
    versionPrefix,
    routes,
    sidebar,
    versions: versions.map((v) => ({
      name: v.name ?? v.slug ?? '',
      href: v === def ? '/' : `/${v.slug}/`,
    })),
  }
}

// --- pages ------------------------------------------------------------

interface PageFile {
  meta: Record<string, string>
  body: string
  file: string
}

async function readPage(dir: string, path: string): Promise<PageFile | null> {
  if (path.includes('..') || path.startsWith('/')) return null
  for (const ext of ['.mdx', '.md']) {
    const file = join(dir, path + ext)
    if (existsSync(file)) {
      const { meta, body } = splitFrontMatter(await readFile(file, 'utf-8'))
      return { meta, body, file }
    }
  }
  return null
}

async function fileHasBody(dir: string, contentPath: string): Promise<boolean> {
  try {
    return splitFrontMatter(await readFile(join(dir, contentPath), 'utf-8')).body.trim().length > 0
  } catch {
    return false
  }
}

/** Flat `key: value` front matter — enough for title/description. */
function splitFrontMatter(src: string): { meta: Record<string, string>; body: string } {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { meta: {}, body: src }
  const meta: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '')
  }
  return { meta, body: src.slice(m[0].length) }
}

// --- HTML shell -------------------------------------------------------

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function renderSidebar(items: SidebarItem[], current: string, depth = 0): string {
  return (
    '<ul>' +
    items
      .map((i) => {
        const label = i.href
          ? `<a href="${esc(i.href)}"${i.href === current ? ' class="active"' : ''}>${esc(i.title)}</a>`
          : `<span class="group">${esc(i.title)}</span>`
        const kids = i.children.length ? renderSidebar(i.children, current, depth + 1) : ''
        return `<li class="d${depth}">${label}${kids}</li>`
      })
      .join('') +
    '</ul>'
  )
}

function findCss(): string {
  // Reuse the published site's content styles when run inside the monorepo.
  const here = new URL('.', import.meta.url).pathname
  for (const rel of ['../../publish-web/src', '../../../publish-web/src', '../../../../publish-web/src']) {
    const f = resolve(here, rel, 'publish-content.css')
    if (existsSync(f)) return f
  }
  return ''
}

const SHELL_CSS = `
:root{--bg:#fff;--fg:#1a1a1a;--muted:#6b7280;--line:#e5e7eb;--accent:#2563eb;--side:#fafafa;
--font-sans:system-ui,-apple-system,sans-serif;--content-text:var(--fg);--primary:var(--accent)}
@media(prefers-color-scheme:dark){:root{--bg:#0b0d10;--fg:#e5e7eb;--muted:#9ca3af;--line:#23272e;--accent:#60a5fa;--side:#0f1216}
.shiki,.shiki span{color:var(--shiki-dark)!important;background-color:var(--shiki-dark-bg)!important}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 system-ui,-apple-system,sans-serif}
.layout{display:grid;grid-template-columns:280px 1fr;min-height:100vh}
aside{background:var(--side);border-right:1px solid var(--line);padding:20px 16px;position:sticky;top:0;height:100vh;overflow:auto}
aside .site{font-weight:700;font-size:18px;margin:0 0 4px}aside .ver{font-size:12px;color:var(--muted);margin-bottom:16px}
aside ul{list-style:none;margin:0;padding:0}aside ul ul{padding-left:12px;border-left:1px solid var(--line);margin-left:6px}
aside li{margin:2px 0}aside .group{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:14px 0 4px}
aside a{display:block;padding:4px 8px;border-radius:6px;color:var(--fg);text-decoration:none;font-size:14px}
aside a:hover{background:var(--line)}aside a.active{background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--accent);font-weight:600}
main{padding:32px 48px;max-width:860px}main h1.title{margin:0 0 4px;font-size:34px}main .desc{color:var(--muted);margin:0 0 24px}
.err{background:#fef2f2;color:#991b1b;border:1px solid #fecaca;border-radius:8px;padding:16px;white-space:pre-wrap;font:13px/1.5 ui-monospace,monospace}
@media(max-width:800px){.layout{grid-template-columns:1fr}aside{position:static;height:auto}main{padding:20px}}
`

function shell(site: Site | null, current: string, title: string, inner: string, css: string): string {
  const side = site
    ? `<div class="site">${esc(site.manifest.name ?? 'Docs')}</div>
       <div class="ver">${esc(site.version.name ?? '')} · local preview</div>
       ${renderSidebar(site.sidebar, current)}`
    : ''
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${css}</style><style>${SHELL_CSS}</style></head>
<body><div class="layout"><aside>${side}</aside><main>${inner}</main></div>
<script>new EventSource('/__livereload').onmessage=()=>location.reload()</script></body></html>`
}

// --- server -----------------------------------------------------------

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.css': 'text/css', '.json': 'application/json',
}

export async function runDev(args: string[]): Promise<number> {
  let dir = '.'
  let port = 3000
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' || args[i] === '-p') port = Number(args[++i])
    else if (!args[i].startsWith('-')) dir = args[i]
  }
  dir = resolve(dir)
  if (!existsSync(join(dir, 'gitdocai.json'))) {
    process.stderr.write(`gitdocai.json not found in ${dir}\n`)
    return 1
  }

  const cssFile = findCss()
  const contentCss = cssFile ? await readFile(cssFile, 'utf-8') : ''
  const clients = new Set<ServerResponse>()

  let timer: NodeJS.Timeout | undefined
  watch(dir, { recursive: true }, (_evt, name) => {
    if (name && /(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(name)) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      process.stdout.write(`changed: ${name ?? '?'}\n`)
      for (const c of clients) c.write('data: reload\n\n')
    }, 80)
  })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let pathname = decodeURIComponent(url.pathname)

    // Backup format references assets as /assets/<id>; map through
    // assets/manifest.json to assets/files/<filename>.
    const am = pathname.match(/^\/assets\/([0-9a-fA-F-]{36})$/)
    if (am) {
      try {
        const list = JSON.parse(await readFile(join(dir, 'assets', 'manifest.json'), 'utf-8')) as {
          id: string; filename: string; mime_type?: string
        }[]
        const hit = list.find((a) => a.id === am[1])
        const file = hit && join(dir, 'assets', 'files', hit.filename)
        if (hit && file && existsSync(file)) {
          res.writeHead(200, { 'content-type': hit.mime_type || MIME[extname(hit.filename)] || 'application/octet-stream', 'cache-control': 'no-store' })
          res.end(await readFile(file))
          return
        }
      } catch {
        /* no asset manifest */
      }
      res.writeHead(404).end('asset not found')
      return
    }

    if (pathname === '/__livereload') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write('\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }

    const send = (status: number, html: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
    }

    // Static files (assets/…): anything inside the docs dir that isn't a page.
    const ext = extname(pathname)
    if (ext && ext !== '.md' && ext !== '.mdx') {
      const file = resolve(dir, '.' + pathname)
      if (file.startsWith(dir + sep) && existsSync(file) && !file.endsWith('gitdocai.json')) {
        res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' })
        res.end(await readFile(file))
        return
      }
      res.writeHead(404).end('not found')
      return
    }

    const wantsMd = pathname.endsWith('.md')
    if (wantsMd) pathname = pathname.slice(0, -3)
    if (pathname.length > 1) pathname = pathname.replace(/\/+$/, '')

    try {
      const site = await buildSite(dir, pathname)

      // `/` (or a version root) → first page of the first section.
      if (!site.routes.has(pathname)) {
        const first = site.routes.values().next().value as Route | undefined
        const isRoot = pathname === '/' || pathname === site.versionPrefix
        if (isRoot && first) {
          res.writeHead(302, { location: first.url }).end()
          return
        }
        return send(404, shell(site, '', 'Not found', `<h1 class="title">404</h1><p class="desc">No page at <code>${esc(pathname)}</code>.</p>`, contentCss))
      }

      const route = site.routes.get(pathname) as Route
      const page = await readPage(dir, route.path)
      if (!page) {
        return send(404, shell(site, pathname, 'Missing file', `<div class="err">Navigation points to "${esc(route.path)}" but no ${esc(route.path)}.mdx / .md exists.</div>`, contentCss))
      }
      if (wantsMd) {
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
        res.end(page.body)
        return
      }

      const title = page.meta.title || route.path.split('/').pop() || route.path
      try {
        const rendered = await renderEntry({
          id: route.path,
          section_id: route.sectionSlug,
          title,
          content: page.body,
        } as unknown as DocEntryLike)
        const desc = page.meta.description ? `<p class="desc">${esc(page.meta.description)}</p>` : ''
        const inner = `<article class="doc-article"><h1 class="title">${esc(title)}</h1>${desc}<div class="tiptap-editor prose-mimic">${rendered.html}</div></article>`
        send(200, shell(site, pathname, title, inner, contentCss))
      } catch (err) {
        // Mintlify-style: keep the preview up and show what broke.
        const msg = err instanceof Error ? err.message : String(err)
        send(500, shell(site, pathname, title, `<h1 class="title">${esc(title)}</h1><div class="err">Failed to render ${esc(page.file)}\n\n${esc(msg)}</div>`, contentCss))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      send(500, shell(null, '', 'Error', `<h1 class="title">Cannot load docs</h1><div class="err">${esc(msg)}</div>`, ''))
    }
  })

  // Same behaviour as `mint dev`: if the port is busy, try the next one.
  await new Promise<void>((done, fail) => {
    const listen = (p: number) => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE' && p < port + 20) listen(p + 1)
        else fail(e)
      })
      server.listen(p, () => {
        process.stdout.write(`GitDocAI dev preview: http://localhost:${p}\nwatching ${dir}\n`)
        done()
      })
    }
    listen(port)
  })

  await new Promise(() => {}) // run until Ctrl+C
  return 0
}
