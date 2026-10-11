import { getS2SToken, type AuthEnv } from './auth'
import { detectAIBot } from './botDetection'
import type { DomainMapping } from './types'

interface PageViewEnv extends AuthEnv {
  CONTENT_RUNTIME_URL?: string
}

interface PageViewInput {
  env: PageViewEnv
  mapping: DomainMapping
  versionId?: string
  sectionId?: string
  entryId?: string
  path: string
  pageTitle: string
  userAgent: string | null
  /** From Cloudflare's request.cf — country/region only, no raw IP. */
  country?: string
  region?: string
}

/**
 * Reports a page view (human or AI crawler) to content-runtime, which
 * relays it to control-plane. Meant to be passed to
 * `Astro.locals.runtime.ctx.waitUntil(...)` by the caller — never awaited
 * on the visitor's response path. Best-effort: swallows every failure,
 * analytics must never break a page render.
 *
 * Bot identity comes from the User-Agent (works on every Cloudflare plan);
 * see botDetection.ts.
 */
export async function reportPageView(input: PageViewInput): Promise<void> {
  const { env, mapping, versionId, sectionId, entryId, path, pageTitle, userAgent, country, region } = input
  if (!env.CONTENT_RUNTIME_URL) return

  try {
    const token = await getS2SToken(env)
    if (!token) return

    const botName = detectAIBot(userAgent)

    await fetch(`${env.CONTENT_RUNTIME_URL}/content/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        organization_id: mapping.orgId,
        documentation_id: mapping.docId,
        version_id: versionId,
        event_type: 'page_view',
        visitor_type: botName ? 'bot' : 'human',
        section_id: sectionId,
        entry_id: entryId,
        path,
        page_title: pageTitle,
        bot_name: botName ?? undefined,
        country,
        region,
      }),
    })
  } catch {
    // best-effort — never let an analytics failure surface to the visitor
  }
}
