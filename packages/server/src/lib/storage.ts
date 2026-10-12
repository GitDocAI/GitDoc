/**
 * The slice of a key-value / object store the server reads from. DATA_DIR on
 * disk implements it (see diskRuntime.ts); any object store that offers the
 * same few methods can stand in for it.
 */
export interface ObjectLike {
  body: ReadableStream | null
  httpMetadata?: { contentType?: string }
  httpEtag?: string
  json<T = unknown>(): Promise<T>
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface BucketLike {
  get(key: string): Promise<ObjectLike | null>
}

export interface KVLike {
  get<T = unknown>(key: string, options?: { type?: 'json'; cacheTtl?: number }): Promise<T | null>
}
