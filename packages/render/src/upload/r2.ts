import { createHash } from 'crypto'
import type { CloudflareTarget } from '../types'
import { fetchWithRetry } from './retry'
import { signRequest } from './sigv4'

/**
 * Cloudflare R2 object uploader. Two transport modes:
 *
 *   1. **S3-compatible endpoint** (preferred when r2_access_key_id /
 *      r2_secret_access_key are configured). Hits
 *      `<account>.r2.cloudflarestorage.com` with AWS Sigv4 signing. Rate
 *      limit: thousands of PUT/s per prefix — scales for concurrent
 *      customer publishes.
 *
 *   2. **CF REST API** (fallback when only the generic CF API token is
 *      configured). Hits `api.cloudflare.com/.../r2/buckets/.../objects/`.
 *      Rate limit: 1200 req per 5min per token (~4/s sustained). A single
 *      publish parallelizes 8 entries; two publishes can already trip
 *      error 971 ("Please wait and consider throttling").
 *
 * Both paths share retry-with-backoff so a transient 429/5xx doesn't kill
 * a publish.
 */
export class R2Uploader {
  private readonly s3Base: string | null
  private readonly restBase: string
  private readonly bucket: string
  /* Every key successfully PUT through this uploader. publish.ts diffs
     this against the live R2 listing to know which keys to delete (i.e.
     entries / sections / versions / assets removed by the user since the
     last publish). Lives on the uploader so the asset migrator's puts
     are tracked too without each caller having to opt in. */
  private readonly writtenKeys = new Set<string>()

  constructor(private readonly target: CloudflareTarget) {
    this.bucket = target.r2_bucket
    this.restBase =
      `${process.env.GITDOC_CF_API_BASE ?? 'https://api.cloudflare.com/client/v4'}/accounts/${target.account_id}` +
      `/r2/buckets/${target.r2_bucket}/objects`
    this.s3Base =
      target.r2_access_key_id && target.r2_secret_access_key
        ? `https://${target.account_id}.r2.cloudflarestorage.com`
        : null
  }

  /** Snapshot of every key written by this uploader instance. */
  getWrittenKeys(): Set<string> {
    return new Set(this.writtenKeys)
  }

  async putJson(key: string, value: unknown): Promise<void> {
    await this.put(key, JSON.stringify(value), 'application/json; charset=utf-8')
  }

  async putHtml(key: string, html: string): Promise<void> {
    await this.put(key, html, 'text/html; charset=utf-8')
  }

  async putText(key: string, text: string, contentType = 'text/plain; charset=utf-8'): Promise<void> {
    await this.put(key, text, contentType)
  }

  /**
   * Upload raw bytes — used for migrated assets (images, etc.) whose
   * content-type we carry over from the source download.
   */
  async putBytes(key: string, bytes: ArrayBuffer, contentType: string): Promise<void> {
    await this.put(key, bytes, contentType)
  }

  /**
   * Read-modify-write _domains/index.json in R2. Merges `puts` into the
   * current index and removes the `removes` hostnames, then writes it back.
   * Uses the REST API for the GET (works regardless of transport mode).
   */
  async patchDomainIndex(
    puts: Array<{ hostname: string; orgId: string; docId: string; isPrivate: boolean }>,
    removes: string[],
  ): Promise<void> {
    const key = '_domains/index.json'
    const getUrl = `${this.restBase}/${encodeR2Key(key)}`

    let current: Record<string, { orgId: string; docId: string; isPrivate: boolean }> = {}
    try {
      const res = await fetch(getUrl, {
        headers: { Authorization: `Bearer ${this.target.api_token}` },
      })
      if (res.ok) {
        current = await res.json()
      }
      // 404 on first publish is expected — start with empty object
    } catch {
      // network error on read — proceed with empty; puts will still land
    }

    for (const h of removes) {
      delete current[h]
    }
    for (const { hostname, orgId, docId, isPrivate } of puts) {
      current[hostname] = { orgId, docId, isPrivate }
    }

    await this.putJson(key, current)
  }

  /**
   * List every key under a prefix. Used by publish to compute the set of
   * keys it should delete (everything that existed pre-publish minus
   * everything written this publish). S3-only — the CF REST API has a
   * list endpoint too but the dev fallback path is rarely under enough
   * write pressure to need cleanup, and adding both transports doubles
   * the surface for diminishing return.
   *
   * Paginated under the hood: R2 returns 1000 keys per ListObjectsV2
   * call, follows the continuation token until exhausted.
   */
  async listObjects(prefix: string): Promise<string[]> {
    if (!this.s3Base) return []
    const keys: string[] = []
    let continuationToken: string | undefined = undefined
    while (true) {
      const url = new URL(`${this.s3Base}/${this.bucket}`)
      url.searchParams.set('list-type', '2')
      url.searchParams.set('prefix', prefix)
      if (continuationToken) {
        url.searchParams.set('continuation-token', continuationToken)
      }
      const signed = signRequest(
        'GET',
        url.toString(),
        '',
        {
          accessKeyId: this.target.r2_access_key_id!,
          secretAccessKey: this.target.r2_secret_access_key!,
        },
      )
      const res = await fetchWithRetry(
        signed.url,
        { method: 'GET', headers: signed.headers },
        { what: `R2 LIST ${prefix}` },
      )
      if (!res.ok) {
        const msg = await safeText(res)
        throw new Error(`R2 LIST ${prefix} → ${res.status} ${res.statusText}: ${msg}`)
      }
      const xml = await res.text()
      for (const match of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
        keys.push(decodeXmlEntities(match[1]))
      }
      const truncatedMatch = xml.match(/<IsTruncated>([^<]+)<\/IsTruncated>/)
      if (truncatedMatch?.[1] !== 'true') break
      const tokenMatch = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)
      if (!tokenMatch) break
      continuationToken = decodeXmlEntities(tokenMatch[1])
    }
    return keys
  }

  /**
   * Batch-delete up to 1000 keys per call (S3 spec limit). Splits larger
   * lists into chunks and runs them sequentially — concurrency would
   * race the publish's own writes for sigv4-clock alignment and isn't
   * needed (cleanup is off the critical path).
   */
  async deleteObjects(keys: string[]): Promise<void> {
    if (!this.s3Base || keys.length === 0) return
    const CHUNK = 1000
    for (let i = 0; i < keys.length; i += CHUNK) {
      const chunk = keys.slice(i, i + CHUNK)
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<Delete>` +
        chunk
          .map((k) => `<Object><Key>${escapeXml(k)}</Key></Object>`)
          .join('') +
        `<Quiet>true</Quiet>` +
        `</Delete>`
      const bodyBuf = Buffer.from(xml, 'utf8')
      // S3's DeleteObjects REQUIRES a Content-MD5 header signed alongside
      // the body — it's how the server verifies it received the exact
      // payload we hashed in sigv4.
      const contentMd5 = createHash('md5').update(bodyBuf).digest('base64')
      const url = `${this.s3Base}/${this.bucket}?delete`
      const signed = signRequest(
        'POST',
        url,
        new Uint8Array(bodyBuf),
        {
          accessKeyId: this.target.r2_access_key_id!,
          secretAccessKey: this.target.r2_secret_access_key!,
        },
        {
          'Content-Type': 'application/xml',
          'Content-MD5': contentMd5,
        },
      )
      const res = await fetchWithRetry(
        signed.url,
        { method: 'POST', headers: signed.headers, body: bodyBuf },
        { what: `R2 DELETE batch (${chunk.length})` },
      )
      if (!res.ok) {
        const msg = await safeText(res)
        throw new Error(`R2 DELETE batch → ${res.status} ${res.statusText}: ${msg}`)
      }
    }
  }

  private async put(
    key: string,
    body: string | ArrayBuffer,
    contentType: string,
  ): Promise<void> {
    const what = `R2 PUT ${key}`
    if (this.s3Base) {
      await this.putS3(key, body, contentType, what)
    } else {
      await this.putRest(key, body, contentType, what)
    }
    // Record only AFTER a successful upload — a failed PUT mid-publish
    // shouldn't get its key marked as "kept" by the cleanup pass.
    this.writtenKeys.add(key)
  }

  private async putS3(
    key: string,
    body: string | ArrayBuffer,
    contentType: string,
    what: string,
  ): Promise<void> {
    const url = `${this.s3Base}/${this.bucket}/${encodeR2Key(key)}`
    // Sigv4 needs the exact bytes to sign — for ArrayBuffer we pass the
    // backing buffer directly so the hash matches what fetch sends.
    const bodyForSign =
      typeof body === 'string' ? body : new Uint8Array(body)
    const signed = signRequest(
      'PUT',
      url,
      bodyForSign,
      {
        accessKeyId: this.target.r2_access_key_id!,
        secretAccessKey: this.target.r2_secret_access_key!,
      },
      { 'Content-Type': contentType },
    )
    const res = await fetchWithRetry(
      signed.url,
      { method: 'PUT', headers: signed.headers, body },
      { what },
    )
    if (!res.ok) {
      const msg = await safeText(res)
      throw new Error(`${what} → ${res.status} ${res.statusText}: ${msg}`)
    }
  }

  private async putRest(
    key: string,
    body: string | ArrayBuffer,
    contentType: string,
    what: string,
  ): Promise<void> {
    const url = `${this.restBase}/${encodeR2Key(key)}`
    const res = await fetchWithRetry(
      url,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${this.target.api_token}`,
          'Content-Type': contentType,
        },
        body,
      },
      { what },
    )
    if (!res.ok) {
      const msg = await safeText(res)
      throw new Error(`${what} → ${res.status} ${res.statusText}: ${msg}`)
    }
  }
}

/** R2 keys can contain `/` (folder-like). encodeURIComponent would escape them. */
function encodeR2Key(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return '<no body>'
  }
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
