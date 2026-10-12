import type { APIRoute } from 'astro'
import { ContentSource, resolveFromRequest, type PageIndexEntry } from '../lib/contentSource'

export const prerender = false

interface DocHeader {
  name?: string
  config?: { seo?: { default_description?: string } }
}

/**
 * llms.txt — the markdown index that tells LLMs what this doc contains
 * and where each page lives (each link points at the page's clean `.md`).
 * See https://llmstxt.org. Built from `pages-index.json` + the doc
 * header, with absolute URLs against the request origin. Private docs
 * 404 (not meant for ingestion).
 */
export const GET: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env
  const source = new ContentSource(env.DOMAINS_KV, env.DOCS_R2)
  const mapping = await resolveFromRequest(
    request,
    source,
    env as unknown as Record<string, unknown>,
  )
  if (mapping instanceof Response || mapping.isPrivate) {
    return new Response('Not found', { status: 404 })
  }

  const [doc, pages] = await Promise.all([
    source.readJson<DocHeader>(source.documentationKey(mapping)),
    source.readJson<PageIndexEntry[]>(source.pagesIndexKey(mapping)),
  ])

  const name = doc?.name?.trim() || 'Documentation'
  const description = doc?.config?.seo?.default_description?.trim() || `${name} documentation`
  const origin = new URL(request.url).origin

  const lines = [`# ${name}`, '', `> ${description}`, '', '## Docs', '']
  for (const p of pages ?? []) {
    // Link to the page's markdown — that's the clean, LLM-friendly view.
    const url = `${origin}${p.path}.md`
    const desc = p.description?.trim()
    lines.push(`- [${p.title}](${url})${desc ? `: ${desc}` : ''}`)
  }

  return new Response(lines.join('\n') + '\n', {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  })
}
