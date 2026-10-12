import { appendFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * Reader events: what people search for, ask and read. Off by default.
 *
 *   EVENTS=file          append JSON lines to DATA_DIR/_events/<docId>.jsonl
 *   EVENTS_URL=...       POST each event as JSON (EVENTS_TOKEN → Bearer)
 *
 * Both may be on. Delivery is best effort and never delays a response.
 * No IP address is recorded; country/region only when the edge supplies them.
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

export function emitEvent(ev: ContentEvent, env: Record<string, string | undefined> = process.env): void {
  const file = env.EVENTS === 'file'
  const url = env.EVENTS_URL
  if (!file && !url) return
  const record = { ts: new Date().toISOString(), ...ev }
  if (file && /^[\w.-]+$/.test(ev.doc_id)) {
    const dir = join(resolve(env.DATA_DIR || './data'), '_events')
    void mkdir(dir, { recursive: true })
      .then(() => appendFile(join(dir, `${ev.doc_id}.jsonl`), JSON.stringify(record) + '\n'))
      .catch(() => {})
  }
  if (url) {
    void fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(env.EVENTS_TOKEN ? { authorization: `Bearer ${env.EVENTS_TOKEN}` } : {}),
      },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {})
  }
}
