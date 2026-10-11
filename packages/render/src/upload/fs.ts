import { mkdir, readdir, rename, rm, writeFile, readFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { DomainMapping } from '../types'

/**
 * Filesystem destination — the same surface as R2Uploader/KVWriter, but the
 * "bucket" is a directory. Keys map 1:1 to relative paths, so publish-web's
 * disk store reads exactly the layout the Worker reads from R2:
 *
 *   <dir>/docs/{docId}/…           pages, trees, assets
 *   <dir>/_domains/index.json      hostname → { orgId, docId, isPrivate }
 *
 * Files are written to a temp name and renamed, so a reader never sees a
 * half-written object.
 */
export class FsUploader {
  private readonly root: string
  private readonly writtenKeys = new Set<string>()

  constructor(dir: string) {
    this.root = resolve(dir)
  }

  getWrittenKeys(): Set<string> {
    return new Set(this.writtenKeys)
  }

  async putJson(key: string, value: unknown): Promise<void> {
    await this.put(key, JSON.stringify(value))
  }
  async putHtml(key: string, html: string): Promise<void> {
    await this.put(key, html)
  }
  async putText(key: string, text: string, _contentType?: string): Promise<void> {
    await this.put(key, text)
  }
  /** Content-type isn't stored: the server infers it from the extension / id. */
  async putBytes(key: string, bytes: ArrayBuffer, contentType: string): Promise<void> {
    await this.put(key, Buffer.from(bytes))
    // Assets are served by id (no extension), so remember the type beside it.
    await this.put(`${key}.meta.json`, JSON.stringify({ contentType }), false)
  }

  async patchDomainIndex(
    puts: Array<{ hostname: string; orgId: string; docId: string; isPrivate: boolean }>,
    removes: string[],
  ): Promise<void> {
    const key = '_domains/index.json'
    let current: Record<string, unknown> = {}
    try {
      current = JSON.parse(await readFile(this.path(key), 'utf-8'))
    } catch {
      /* first publish */
    }
    for (const h of removes) delete current[h]
    // A doc's hostnames are the ones from its latest publish: drop the old
    // names it answered on, so renaming a site doesn't leave a stale address.
    const docs = new Set(puts.map((p) => p.docId))
    for (const [h, v] of Object.entries(current)) {
      if (docs.has((v as { docId?: string }).docId ?? '')) delete current[h]
    }
    for (const { hostname, orgId, docId, isPrivate } of puts) {
      current[hostname] = { orgId, docId, isPrivate }
    }
    await this.put(key, JSON.stringify(current), false)
  }

  async listObjects(prefix: string): Promise<string[]> {
    const out: string[] = []
    const walk = async (rel: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(join(this.root, rel), { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const next = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) await walk(next)
        else if (next.startsWith(prefix) && !next.endsWith('.meta.json')) out.push(next)
      }
    }
    await walk(prefix.replace(/\/$/, ''))
    return out
  }

  async deleteObjects(keys: string[]): Promise<void> {
    for (const k of keys) {
      await rm(this.path(k), { force: true })
      await rm(this.path(`${k}.meta.json`), { force: true })
    }
  }

  private path(key: string): string {
    const p = resolve(this.root, key)
    if (p !== this.root && !p.startsWith(this.root + sep)) {
      throw new Error(`key escapes the data dir: ${key}`)
    }
    return p
  }

  private async put(key: string, body: string | Buffer, track = true): Promise<void> {
    const file = this.path(key)
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, body)
    await rename(tmp, file)
    if (track) this.writtenKeys.add(key)
  }
}

/** Domains live in `_domains/index.json` (patched by FsUploader); nothing else to write. */
export class FsKvWriter {
  async putMapping(_mapping: DomainMapping): Promise<void> {}
}
