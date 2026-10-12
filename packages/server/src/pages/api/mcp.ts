import type { APIRoute } from 'astro'
import { canAccessDoc } from '../../lib/auth'
import { ContentSource } from '../../lib/contentSource'
import { clientKey, envInt, hit, tooMany } from '../../lib/rateLimit'
import { searchBackend, type SearchDoc } from '../../lib/search'

export const prerender = false

/**
 * A read-only MCP server (Streamable HTTP, JSON-RPC over POST) for the
 * documentation served on this host, so an AI agent can search and read it:
 *
 *   claude mcp add --transport http docs https://docs.example.com/api/mcp
 *
 * Tools: search_docs, read_page, list_pages. It exposes only what the public
 * site already shows; a private doc needs a reader session, which MCP clients
 * don't have, so it answers 401 there.
 */

const PROTOCOL = '2025-03-26'
const INSTRUCTIONS = 'Search and read this documentation. Start with search_docs, then read_page for the full text.'

const TOOLS = [
  {
    name: 'search_docs',
    description: 'Search the documentation. Returns matching pages with their path and a snippet.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for' },
        limit: { type: 'number', description: 'Maximum results (default 8, max 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_page',
    description: 'Read one page as Markdown, by the path returned from search_docs or list_pages.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Page path, e.g. /guides/install' } },
      required: ['path'],
    },
  },
  {
    name: 'list_pages',
    description: 'List every page: path and title.',
    inputSchema: { type: 'object', properties: {} },
  },
]

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ok = (id: unknown, result: unknown) => reply({ jsonrpc: '2.0', id, result })
const fail = (id: unknown, code: number, message: string) => reply({ jsonrpc: '2.0', id, error: { code, message } })
const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) })

// No server-initiated stream: a GET is answered 405, as the spec allows.
export const GET: APIRoute = () => new Response(null, { status: 405, headers: { allow: 'POST' } })

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const mapping = locals.docMapping
  if (!mapping) return reply({ error: 'no documentation for this host' }, 404)
  if (mapping.isPrivate) {
    if (!locals.session) return reply({ error: 'unauthorized' }, 401)
    if (!canAccessDoc(locals.session, mapping)) return reply({ error: 'forbidden' }, 403)
  }
  const verdict = hit(`mcp:${clientKey(request, clientAddress)}`, envInt('RATE_SEARCH_PER_MIN', 120), 60_000)
  if (!verdict.ok) return tooMany(verdict)

  let msg: { id?: unknown; method?: string; params?: any }
  try {
    msg = await request.json()
  } catch {
    return fail(null, -32700, 'parse error')
  }
  if (Array.isArray(msg) || typeof msg?.method !== 'string') return fail(msg?.id ?? null, -32600, 'invalid request')
  const { id, method, params } = msg
  if (id === undefined) return new Response(null, { status: 202 }) // a notification

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'gitdoc', version: '0.1.0' },
        instructions: INSTRUCTIONS,
      })
    case 'ping':
      return ok(id, {})
    case 'tools/list':
      return ok(id, { tools: TOOLS })
    case 'tools/call':
      break
    default:
      return fail(id, -32601, `method not found: ${method}`)
  }

  const args = (params?.arguments ?? {}) as Record<string, unknown>
  const site = { orgId: mapping.orgId, docId: mapping.docId }
  const env = locals.runtime.env
  const source = new ContentSource(env.DOMAINS_KV, env.DOCS_R2)
  const pages = () => source.readJson<SearchDoc[]>(`docs/${mapping.docId}/search-docs.json`).then((p) => p ?? [])

  try {
    switch (params?.name) {
      case 'search_docs': {
        const query = typeof args.query === 'string' ? args.query.trim().slice(0, 300) : ''
        if (!query) return ok(id, text('query is required', true))
        const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 20)
        const res = await searchBackend().search(site, { query, limit })
        if (!res.length) return ok(id, text('No pages matched.'))
        return ok(
          id,
          text(
            res
              .map((r) => `- ${r.title} — ${r.path}${r.highlights[0] ? `\n  ${r.highlights[0].replace(/<\/?mark>/g, '')}` : ''}`)
              .join('\n'),
          ),
        )
      }
      case 'read_page': {
        const path = typeof args.path === 'string' ? args.path.replace(/\.md$/, '').replace(/\/+$/, '') || '/' : ''
        const page = (await pages()).find((p) => p.path === path)
        if (!page) return ok(id, text(`No page at ${path}. Use list_pages or search_docs for valid paths.`, true))
        return ok(id, text(`# ${page.title}\n\n${page.content}`))
      }
      case 'list_pages':
        return ok(id, text((await pages()).map((p) => `- ${p.path} — ${p.title}`).join('\n') || 'No pages.'))
      default:
        return fail(id, -32602, `unknown tool: ${String(params?.name)}`)
    }
  } catch (e) {
    console.error('mcp failed:', (e as Error).message)
    return ok(id, text('The documentation is temporarily unavailable.', true))
  }
}
