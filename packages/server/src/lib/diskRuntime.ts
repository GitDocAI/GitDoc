import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { Readable } from 'node:stream'

/**
 * Disk-backed stand-ins for the Cloudflare bindings, so the SAME pages and
 * routes run on plain Node (Docker / self-hosted) with no Cloudflare:
 *
 *   DOCS_R2     → files under DATA_DIR, keys are relative paths
 *                 (layout written by render-cli `output: { kind: 'fs' }`)
 *   DOMAINS_KV  → empty: hostnames resolve from `_domains/index.json`
 *   waitUntil   → fire-and-forget
 *
 * Only the slice of the R2/KV API that publish-web actually calls.
 */

export interface DiskObject {
  body: ReadableStream
  httpMetadata: { contentType?: string }
  httpEtag: string
  json<T = unknown>(): Promise<T>
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}

const TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
}

export class DiskBucket {
  private readonly root: string
  constructor(dir: string) {
    this.root = resolve(dir)
  }

  /** Resolve a key to a path, refusing anything that escapes the data dir. */
  private path(key: string): string | null {
    if (key.includes('\0')) return null
    const p = resolve(this.root, key)
    return p === this.root || p.startsWith(this.root + sep) ? p : null
  }

  async get(key: string): Promise<DiskObject | null> {
    const file = this.path(key)
    if (!file) return null
    let st
    try {
      st = await stat(file)
    } catch {
      return null
    }
    if (!st.isFile()) return null

    let contentType = TYPES[file.slice(file.lastIndexOf('.'))]
    if (!contentType) {
      // Assets are keyed by id (no extension); the uploader stores the type beside them.
      try {
        contentType = JSON.parse(await readFile(`${file}.meta.json`, 'utf-8')).contentType
      } catch {
        /* unknown → octet-stream */
      }
    }
    const read = () => readFile(file)
    return {
      get body() {
        return Readable.toWeb(createReadStream(file)) as unknown as ReadableStream
      },
      httpMetadata: { contentType },
      httpEtag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`,
      json: async <T,>() => JSON.parse((await read()).toString('utf-8')) as T,
      text: async () => (await read()).toString('utf-8'),
      arrayBuffer: async () => {
        const b = await read()
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
      },
    }
  }
}

export const emptyKv = {
  async get(): Promise<null> {
    return null
  },
}

/** Shape of `locals.runtime` that the Cloudflare adapter would have provided. */
export function createDiskRuntime(processEnv: Record<string, string | undefined>) {
  const dataDir = processEnv.DATA_DIR || './data'
  return {
    env: {
      ...processEnv,
      DOCS_R2: new DiskBucket(dataDir),
      DOMAINS_KV: emptyKv,
    },
    ctx: {
      waitUntil(p: Promise<unknown>) {
        p.catch(() => {})
      },
    },
    cf: undefined,
  }
}
