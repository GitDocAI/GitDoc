/**
 * Where the visitor is, as far as the edge told us. Behind Cloudflare the
 * country arrives in `CF-IPCountry` (and, with "visitor location headers"
 * enabled, `CF-Region`). Only believed when TRUST_PROXY=true: otherwise any
 * client could claim one. No IP address is ever read for this.
 */
export function visitorGeo(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): { country?: string; region?: string } {
  if (env.TRUST_PROXY !== 'true') return {}
  const c = request.headers.get('cf-ipcountry')?.toUpperCase()
  const country = c && /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1' ? c : undefined
  const r = request.headers.get('cf-region') || request.headers.get('cf-region-code') || undefined
  return { country, region: r ? r.slice(0, 64) : undefined }
}
