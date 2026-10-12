import { appendFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { getS2SToken } from './auth'

/**
 * Reader events: what people search for, ask and read. Off by default.
 *
 *   EVENTS=file       append JSON lines to DATA_DIR/_events/<docId>.jsonl
 *   EVENTS=gitdocai   report to the hosted control plane (see below)
 *   EVENTS_URL=...    POST each event as JSON (EVENTS_TOKEN → Bearer)
 *
 * `EVENTS` takes a comma-separated list; EVENTS_URL is independent. Delivery
 * is best effort and never delays a response. No IP address is recorded;
 * country/region only when the edge supplies them.
 *
 * `gitdocai` speaks the control plane's analytics contract:
 *   POST {CONTROL_PLANE_URL}/control-plane/api/v1/analytics/events
 *   Authorization: Bearer <service token for audience "control-plane">
 * minted from IAM_URL with PUBLISH_WEB_CLIENT_ID / PUBLISH_WEB_CLIENT_SECRET.
 */
export interface ContentEvent {
  type: 'page_view' | 'search' | 'question'
  org_id: string
  doc_id: string
  version_id?: string
  section_id?: string
  entry_id?: string
  path?: string
  page_title?: string
  query_text?: string
  was_answered?: boolean
  result_count?: number
  visitor_type?: 'human' | 'bot'
  bot_name?: string
  country?: string
  region?: string
}

/** Which sinks are switched on, from EVENTS. */
export function eventSinks(env: Record<string, string | undefined> = process.env): string[] {
  const kinds = (env.EVENTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (env.EVENTS_URL) kinds.push('http')
  return kinds.filter((k) => k === 'file' || k === 'gitdocai' || k === 'http')
}

/** The control plane's `Event`, from ours. */
function controlPlaneEvent(ev: ContentEvent) {
  return {
    organization_id: ev.org_id,
    documentation_id: ev.doc_id,
    version_id: ev.version_id,
    event_type: ev.type,
    visitor_type: ev.visitor_type,
    section_id: ev.section_id,
    entry_id: ev.entry_id,
    path: ev.path,
    page_title: ev.page_title,
    query_text: ev.query_text,
    was_answered: ev.was_answered,
    bot_name: ev.bot_name,
    country: ev.country,
    region: ev.region,
  }
}

export function emitEvent(ev: ContentEvent, env: Record<string, string | undefined> = process.env): void {
  const sinks = eventSinks(env)
  if (!sinks.length) return
  const record = { ts: new Date().toISOString(), ...ev }

  if (sinks.includes('file') && /^[\w.-]+$/.test(ev.doc_id)) {
    const dir = join(resolve(env.DATA_DIR || './data'), '_events')
    void mkdir(dir, { recursive: true })
      .then(() => appendFile(join(dir, `${ev.doc_id}.jsonl`), JSON.stringify(record) + '\n'))
      .catch(() => {})
  }

  if (sinks.includes('http') && env.EVENTS_URL) {
    void fetch(env.EVENTS_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(env.EVENTS_TOKEN ? { authorization: `Bearer ${env.EVENTS_TOKEN}` } : {}),
      },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {})
  }

  if (sinks.includes('gitdocai') && env.CONTROL_PLANE_URL) {
    void (async () => {
      const token = await getS2SToken(env, 'control-plane')
      if (!token) return
      await fetch(`${env.CONTROL_PLANE_URL!.replace(/\/+$/, '')}/control-plane/api/v1/analytics/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(controlPlaneEvent(ev)),
        signal: AbortSignal.timeout(10_000),
      })
    })().catch(() => {})
  }
}
