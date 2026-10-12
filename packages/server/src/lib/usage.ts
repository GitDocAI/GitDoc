import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * What a site has consumed, for enforcing quotas and for the operator to read
 * (`GET /api/usage`). Only the assistant is counted: it is the part that costs
 * money. Counters are in memory and written to DATA_DIR/_usage/<docId>.json on
 * every change (questions are rare), so a restart does not hand out a new day.
 * Day and month are UTC.
 */
export interface Usage {
  day: string
  month: string
  ask_today: number
  ask_this_month: number
}

const live = new Map<string, Usage>()

const today = (now: Date) => now.toISOString().slice(0, 10)

function file(docId: string, env: Record<string, string | undefined>): string {
  if (!/^[\w.-]+$/.test(docId)) throw new Error('invalid doc id')
  return join(resolve(env.DATA_DIR || './data'), '_usage', `${docId}.json`)
}

async function load(
  docId: string,
  env: Record<string, string | undefined>,
  now: Date,
  fresh = false,
): Promise<Usage> {
  const key = `${resolve(env.DATA_DIR || './data')}:${docId}`
  // `fresh` re-reads the file: another process (the server) is the one counting.
  let u = fresh ? undefined : live.get(key)
  if (!u) {
    try {
      u = JSON.parse(await readFile(file(docId, env), 'utf-8')) as Usage
    } catch {
      u = { day: '', month: '', ask_today: 0, ask_this_month: 0 }
    }
  }
  const d = today(now)
  const m = d.slice(0, 7)
  if (u.day !== d) u = { ...u, day: d, ask_today: 0 }
  if (u.month !== m) u = { ...u, month: m, ask_this_month: 0 }
  live.set(key, u)
  return u
}

export async function readUsage(docId: string, env = process.env, now = new Date(), fresh = false): Promise<Usage> {
  return { ...(await load(docId, env, now, fresh)) }
}

/**
 * Take one question from the site's allowance. Returns whether it fits; when it
 * does, the counters are advanced and saved.
 */
export async function takeAsk(
  docId: string,
  limits: { perDay: number | null; perMonth: number | null },
  env = process.env,
  now = new Date(),
): Promise<{ ok: true } | { ok: false; reason: 'day' | 'month'; limit: number }> {
  const u = await load(docId, env, now)
  if (limits.perDay !== null && u.ask_today >= limits.perDay) return { ok: false, reason: 'day', limit: limits.perDay }
  if (limits.perMonth !== null && u.ask_this_month >= limits.perMonth) {
    return { ok: false, reason: 'month', limit: limits.perMonth }
  }
  u.ask_today++
  u.ask_this_month++
  const f = file(docId, env)
  try {
    await mkdir(join(f, '..'), { recursive: true })
    const tmp = `${f}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(u))
    await rename(tmp, f)
  } catch {
    /* counting in memory still protects this process */
  }
  return { ok: true }
}
