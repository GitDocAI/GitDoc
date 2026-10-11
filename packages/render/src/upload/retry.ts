/**
 * Shared retry-with-backoff for Cloudflare API PUTs (R2 + KV). The native
 * REST API for R2 has a soft rate-limit that fires error 971 ("Please
 * wait and consider throttling your request speed") under burst load —
 * concurrent publishes from multiple customers, or a single publish
 * that issues 8 PUTs in parallel per `forEachWithConcurrency(8)`, can
 * easily trip it. Without retry, one 429 fails the whole publish.
 *
 * Strategy: on 429 or 5xx, sleep `min(maxDelay, baseDelay * 2^attempt)`
 * plus 0–25% jitter and try again. If the server sends `Retry-After`
 * (seconds), honor it. Permanent failures (4xx other than 429, 408,
 * 425) bubble up immediately.
 */

export interface FetchWithRetryOptions {
  /** Operation label for error messages (e.g. "R2 PUT docs/.../doc.json"). */
  what: string
  /** Max attempts including the first try. Default 6 → up to ~32s wait. */
  maxAttempts?: number
  /** Base delay in ms for the exponential schedule. Default 250. */
  baseDelayMs?: number
  /** Hard cap on a single sleep. Default 8000. */
  maxDelayMs?: number
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: FetchWithRetryOptions,
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? 6
  const baseDelayMs = opts.baseDelayMs ?? 250
  const maxDelayMs = opts.maxDelayMs ?? 8000

  let lastErrText = ''
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res: Response
    try {
      res = await fetch(url, init)
    } catch (networkErr) {
      // Network-layer failures (DNS, TCP reset, etc.) — same retry budget.
      lastErrText = networkErr instanceof Error ? networkErr.message : String(networkErr)
      if (attempt === maxAttempts - 1) break
      await sleep(backoffMs(attempt, baseDelayMs, maxDelayMs))
      continue
    }

    if (res.ok || !RETRYABLE_STATUS.has(res.status)) return res

    // Retryable error. Capture body for the eventual final-failure message,
    // but only consume it on the LAST attempt (response bodies can be read
    // once; if we drain it here on success-track attempts we'd lose nothing
    // anyway, but staying lean).
    if (attempt === maxAttempts - 1) {
      lastErrText = await safeText(res)
      break
    }

    const retryAfter = parseRetryAfter(res.headers.get('Retry-After'))
    const delay = retryAfter ?? backoffMs(attempt, baseDelayMs, maxDelayMs)
    // Drain body so the connection can be reused before we sleep.
    await safeText(res)
    await sleep(delay)
  }

  throw new Error(
    `${opts.what} failed after ${maxAttempts} attempts: ${lastErrText || 'no body'}`,
  )
}

function backoffMs(attempt: number, base: number, max: number): number {
  const exp = base * Math.pow(2, attempt)
  const capped = Math.min(exp, max)
  // 0–25% jitter — spreads bursts when multiple publishes retry in lockstep.
  return capped + Math.random() * capped * 0.25
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null
  // RFC 7231 allows either an integer (seconds) or an HTTP-date. Cloudflare
  // sends integers in practice.
  const n = parseInt(header, 10)
  if (!Number.isNaN(n) && n > 0) return n * 1000
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
