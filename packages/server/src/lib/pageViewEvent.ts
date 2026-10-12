import { detectAIBot } from './botDetection'
import { emitEvent } from './events'
import type { DomainMapping } from './types'

interface PageViewInput {
  // Kept so call sites stay unchanged; events no longer need the bindings.
  env?: unknown
  mapping: DomainMapping
  versionId?: string
  sectionId?: string
  entryId?: string
  path: string
  pageTitle: string
  userAgent: string | null
  /** From the edge (e.g. Cloudflare's request.cf) — country/region only, no raw IP. */
  country?: string
  region?: string
}

/**
 * Records a page view (human or AI crawler) through the configured event sink
 * (see events.ts). Best effort: analytics must never break a page render.
 * Bot identity comes from the User-Agent; see botDetection.ts.
 */
export async function reportPageView(input: PageViewInput): Promise<void> {
  const { mapping, versionId, sectionId, entryId, path, pageTitle, userAgent, country, region } = input
  try {
    const botName = detectAIBot(userAgent)
    emitEvent({
      type: 'page_view',
      org_id: mapping.orgId,
      doc_id: mapping.docId,
      version_id: versionId,
      section_id: sectionId,
      entry_id: entryId,
      path,
      page_title: pageTitle,
      visitor_type: botName ? 'bot' : 'human',
      bot_name: botName ?? undefined,
      country,
      region,
    })
  } catch {
    /* best effort */
  }
}
