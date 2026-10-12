import type { CloudflareTarget, DomainMapping } from '../types'
import { fetchWithRetry } from './retry'

/**
 * Cloudflare Workers KV writer. Used at publish time to tell the Worker
 * which doc owns each hostname. The Worker reads this on every request.
 *
 * Endpoint:
 *   PUT /accounts/{account_id}/storage/kv/namespaces/{namespace_id}/values/{key}
 * Auth: Bearer API token with Workers KV Edit permission.
 *
 * KV has no S3-compatible alternative; we rely on retry-with-backoff to
 * survive the occasional 429 from the CF REST API (the volume is low —
 * one write per hostname per publish — so this is rarely the bottleneck).
 */
export class KVWriter {
  private readonly base: string

  constructor(private readonly target: CloudflareTarget) {
    this.base =
      `${process.env.GITDOC_CF_API_BASE ?? 'https://api.cloudflare.com/client/v4'}/accounts/${target.account_id}` +
      `/storage/kv/namespaces/${target.kv_namespace_id}/values`
  }

  /**
   * Write the mapping record for one hostname. The CLI loops over all
   * hostnames the doc owns (default + customs) and calls this per entry.
   */
  async putMapping(mapping: DomainMapping): Promise<void> {
    const key = encodeURIComponent(mapping.hostname)
    const body = JSON.stringify({
      orgId: mapping.org_id,
      docId: mapping.doc_id,
      isPrivate: mapping.is_private,
    })

    const what = `KV PUT ${mapping.hostname}`
    const res = await fetchWithRetry(
      `${this.base}/${key}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${this.target.api_token}`,
          'Content-Type': 'application/json',
        },
        body,
      },
      { what },
    )

    if (!res.ok) {
      const msg = await safeText(res)
      throw new Error(`${what} → ${res.status}: ${msg}`)
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return '<no body>'
  }
}
