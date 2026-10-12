import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * Per-site settings owned by the OPERATOR of the server, changed at runtime
 * through the admin API (`/api/settings`), never baked into the docs.
 *
 *   docs repo (gitdocai.json)   what the author controls: pages, theme,
 *                               whether the assistant panel is shown, …
 *   site settings (this file)   what the operator controls: quotas, and
 *                               (soon) who may read a private site. May hold
 *                               secrets, so it never travels with the docs.
 *   environment                 defaults for the whole instance, and the
 *                               engine's own secrets.
 *
 * On a self-hosted server the operator is you (curl, or `gitdoc settings`).
 * In the hosted product the control plane writes them when a plan changes.
 *
 * Stored in DATA_DIR/_settings/<docId>.json, keyed by documentation id so a
 * hostname change keeps them. Read per request through a short cache, so a
 * change applies without restarting.
 */

/** `null` (or -1) means "no limit"; 0 means "none allowed". */
export interface Quota {
  /** Questions to the assistant per documentation per day / calendar month (UTC). */
  ask_per_day?: number | null
  ask_per_month?: number | null
  /** Per visitor, per minute. */
  ask_per_min_per_visitor?: number | null
  search_per_min_per_visitor?: number | null
}

export interface SiteSettings {
  quota?: Quota
}

export const QUOTA_KEYS = [
  'ask_per_day',
  'ask_per_month',
  'ask_per_min_per_visitor',
  'search_per_min_per_visitor',
] as const

/** Instance-wide defaults (environment), used where a site sets nothing. */
export function quotaDefaults(env: Record<string, string | undefined> = process.env): Required<Quota> {
  const n = (name: string, fallback: number | null) => {
    const raw = env[name]
    if (raw === undefined || raw === '') return fallback
    const v = Number(raw)
    return Number.isFinite(v) ? (v < 0 ? null : v) : fallback
  }
  return {
    ask_per_day: n('ASK_DAILY_LIMIT', 1000),
    ask_per_month: n('ASK_MONTHLY_LIMIT', null),
    ask_per_min_per_visitor: n('RATE_ASK_PER_MIN', 10),
    search_per_min_per_visitor: n('RATE_SEARCH_PER_MIN', 120),
  }
}

/** The quota in force for a site: its own values over the instance defaults. */
export async function effectiveQuota(docId: string, env = process.env): Promise<Required<Quota>> {
  const own = (await loadSettings(docId, env)).quota ?? {}
  const out = quotaDefaults(env)
  for (const k of QUOTA_KEYS) {
    if (k in own) {
      const v = own[k]
      out[k] = v === null || v === undefined || v < 0 ? null : v
    }
  }
  return out
}

/** Validate input from the admin API. Throws a message fit to show the caller. */
export function parseSettings(input: unknown): SiteSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('settings must be a JSON object')
  const out: SiteSettings = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (key !== 'quota') throw new Error(`unknown setting "${key}"`)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('"quota" must be an object')
    const quota: Quota = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!(QUOTA_KEYS as readonly string[]).includes(k)) throw new Error(`unknown quota "${k}"`)
      if (v !== null && !(typeof v === 'number' && Number.isInteger(v) && v >= -1 && v <= 1_000_000_000)) {
        throw new Error(`quota "${k}" must be a whole number, or null for no limit`)
      }
      ;(quota as Record<string, number | null>)[k] = v === -1 ? null : (v as number | null)
    }
    out.quota = quota
  }
  return out
}

const TTL_MS = 5_000
const cache = new Map<string, { exp: number; value: SiteSettings }>()

function file(docId: string, env: Record<string, string | undefined>): string {
  if (!/^[\w.-]+$/.test(docId)) throw new Error('invalid doc id')
  return join(resolve(env.DATA_DIR || './data'), '_settings', `${docId}.json`)
}

export async function loadSettings(docId: string, env: Record<string, string | undefined> = process.env): Promise<SiteSettings> {
  const f = file(docId, env)
  const hit = cache.get(f)
  if (hit && hit.exp > Date.now()) return hit.value
  let value: SiteSettings = {}
  try {
    value = JSON.parse(await readFile(f, 'utf-8')) as SiteSettings
  } catch {
    /* none set */
  }
  cache.set(f, { exp: Date.now() + TTL_MS, value })
  return value
}

export async function saveSettings(
  docId: string,
  settings: SiteSettings,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const f = file(docId, env)
  await mkdir(join(f, '..'), { recursive: true })
  const tmp = `${f}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
  await rename(tmp, f)
  cache.delete(f)
}
