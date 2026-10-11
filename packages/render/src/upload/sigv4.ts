import { createHash, createHmac } from 'crypto'

/**
 * Minimal AWS Signature V4 signer, used to talk to Cloudflare R2's
 * S3-compatible endpoint (which has 10000x the rate limit of CF's REST
 * API for R2 objects). We implement the algorithm by hand instead of
 * pulling in `@aws-sdk/client-s3` — the SDK is ~500KB and we use exactly
 * one operation (PutObject).
 *
 * Algorithm reference:
 *   docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html
 *
 * For R2 specifically:
 *   - region: "auto"
 *   - service: "s3"
 *   - host: `<account_id>.r2.cloudflarestorage.com`
 *   - credentials: R2 API token (Access Key ID + Secret Access Key)
 *     created from the R2 dashboard, NOT the generic CF API token.
 */

export interface Sigv4Credentials {
  accessKeyId: string
  secretAccessKey: string
  region?: string // default "auto" for R2
  service?: string // default "s3" for R2
}

export interface SignedRequest {
  url: string
  headers: Record<string, string>
}

/**
 * Sign an HTTP request. Mutates nothing; returns the URL + the headers
 * to send (caller passes these into fetch alongside method+body).
 *
 * @param body Required for sha256 payload signing. Pass empty string for
 *             zero-byte requests. ArrayBuffer for binary uploads.
 */
export function signRequest(
  method: string,
  url: string,
  body: string | Uint8Array,
  creds: Sigv4Credentials,
  extraHeaders: Record<string, string> = {},
): SignedRequest {
  const region = creds.region ?? 'auto'
  const service = creds.service ?? 's3'

  const u = new URL(url)
  const host = u.host
  const canonicalUri = canonicalizeUri(u.pathname)
  const canonicalQuery = canonicalizeQuery(u.searchParams)

  const now = new Date()
  const amzDate = isoBasic(now) // 20260601T120000Z
  const dateStamp = amzDate.slice(0, 8) // 20260601

  const payloadHash = sha256Hex(body)

  // Required headers (host, x-amz-date, x-amz-content-sha256) plus
  // whatever the caller passed in (typically Content-Type).
  const headers: Record<string, string> = {
    host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    ...lowercaseKeys(extraHeaders),
  }

  // Canonical headers: sorted by lowercase name, with values trimmed and
  // inner whitespace runs collapsed (but we skip the collapsing — none of
  // our headers have multi-space values).
  const sortedNames = Object.keys(headers).sort()
  const canonicalHeaders =
    sortedNames.map((n) => `${n}:${headers[n].trim()}`).join('\n') + '\n'
  const signedHeaders = sortedNames.join(';')

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n')

  const signingKey = deriveSigningKey(creds.secretAccessKey, dateStamp, region, service)
  const signature = hmacHex(signingKey, stringToSign)

  const authorization =
    `AWS4-HMAC-SHA256 ` +
    `Credential=${creds.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`

  // Capitalize headers back to a friendlier shape for fetch (it doesn't
  // actually care about case — HTTP/1.1 + HTTP/2 normalize — but reads
  // nicer in debug logs).
  const outHeaders: Record<string, string> = {
    Authorization: authorization,
    Host: host,
    'X-Amz-Date': amzDate,
    'X-Amz-Content-Sha256': payloadHash,
  }
  for (const [k, v] of Object.entries(extraHeaders)) outHeaders[k] = v

  return { url, headers: outHeaders }
}

function canonicalizeUri(path: string): string {
  // R2 keys can contain `/` (folder-like). Encode each segment
  // separately so slashes stay literal.
  if (!path || path === '/') return '/'
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/[!*'()]/g, (c) =>
      `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    ))
    .join('/')
}

function canonicalizeQuery(params: URLSearchParams): string {
  const pairs: Array<[string, string]> = []
  for (const [k, v] of params) pairs.push([k, v])
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return pairs
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .join('&')
}

function encodeRfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function isoBasic(d: Date): string {
  // ISO-8601 basic form: YYYYMMDDTHHMMSSZ
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
}

function sha256Hex(data: string | Uint8Array): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
  return createHash('sha256').update(buf).digest('hex')
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

function hmacHex(key: Buffer, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('hex')
}

function deriveSigningKey(
  secret: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac('AWS4' + secret, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  return hmac(kService, 'aws4_request')
}

function lowercaseKeys(obj: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) out[k.toLowerCase()] = v
  return out
}
