/**
 * Fixed-window, in-memory limits. One process, so they reset on restart and
 * are not shared between replicas: they exist to stop a visitor (or a bug)
 * from running up the AI bill, not to be an exact quota.
 *
 * The numbers come from the site's settings (lib/settings.ts), over instance
 * defaults from RATE_SEARCH_PER_MIN, RATE_ASK_PER_MIN and ASK_DAILY_LIMIT.
 *   TRUST_PROXY=true      take the client from CF-Connecting-IP / X-Forwarded-For
 */

interface Window {
  count: number
  reset: number
}
const windows = new Map<string, Window>()
const MAX_KEYS = 50_000

export interface Verdict {
  ok: boolean
  retryAfter: number
}

/** `max` null = unlimited; 0 = nothing is allowed. */
export function hit(key: string, max: number | null, windowMs: number, now = Date.now()): Verdict {
  if (max === null) return { ok: true, retryAfter: 0 }
  if (max <= 0) return { ok: false, retryAfter: Math.ceil(windowMs / 1000) }
  if (windows.size > MAX_KEYS) {
    for (const [k, w] of windows) if (w.reset <= now) windows.delete(k)
    if (windows.size > MAX_KEYS) windows.clear() // under attack: forget, don't grow
  }
  let w = windows.get(key)
  if (!w || w.reset <= now) windows.set(key, (w = { count: 0, reset: now + windowMs }))
  w.count++
  return w.count > max
    ? { ok: false, retryAfter: Math.max(1, Math.ceil((w.reset - now) / 1000)) }
    : { ok: true, retryAfter: 0 }
}

export function envInt(name: string, fallback: number, env: Record<string, string | undefined> = process.env): number {
  const n = Number(env[name])
  return env[name] !== undefined && env[name] !== '' && Number.isFinite(n) ? n : fallback
}

/** The visitor's address, only trusting proxy headers when told to. */
export function clientKey(request: Request, clientAddress: string | undefined, env = process.env): string {
  if (env.TRUST_PROXY === 'true') {
    const cf = request.headers.get('cf-connecting-ip')
    if (cf) return cf
    const xff = request.headers.get('x-forwarded-for')
    if (xff) return xff.split(',')[0].trim()
  }
  return clientAddress || 'unknown'
}

export function tooMany(v: Verdict): Response {
  return new Response(JSON.stringify({ error: 'too many requests, try again shortly' }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': String(v.retryAfter) },
  })
}
