/**
 * One client for any OpenAI-compatible endpoint: OpenAI, Ollama (`/v1`),
 * vLLM, LiteLLM, ThreatWinds. They share `/chat/completions` and `/embeddings`;
 * only the authentication differs:
 *
 *   AI_API_KEY only          → `Authorization: Bearer <key>`
 *   AI_API_KEY + AI_API_SECRET → `api-key` / `api-secret` headers (ThreatWinds)
 *
 *   AI_URL                base URL, e.g. https://apis.threatwinds.com/api/ai/v1
 *   AI_CHAT_MODEL         model for answering (Ask)
 *   AI_EMBEDDING_MODEL    model for vectors (hybrid search)
 *
 * Chat and embeddings are independent: set only the one you want.
 *
 * Chat can have a second endpoint that is tried when the first one fails (down,
 * timing out, 4xx/5xx). Same shape, any OpenAI-compatible API, for example
 * Google's (https://generativelanguage.googleapis.com/v1beta/openai):
 *
 *   AI_FALLBACK_URL / AI_FALLBACK_API_KEY / AI_FALLBACK_API_SECRET
 *   AI_FALLBACK_CHAT_MODEL
 *
 * Embeddings never fall back: a different model is a different vector space.
 * They can live on another endpoint than chat (for example chat on ThreatWinds
 * and embeddings on Google, whose model is the one an existing index was built
 * with):
 *
 *   AI_EMBEDDING_URL / AI_EMBEDDING_API_KEY / AI_EMBEDDING_API_SECRET
 *   (+ AI_EMBEDDING_MODEL as usual; without AI_EMBEDDING_URL, AI_URL is used)
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

export interface Embedder {
  readonly model: string
  embed(inputs: string[]): Promise<number[][]>
}

export interface Chat {
  readonly model: string
  complete(messages: ChatMessage[], opts?: ChatOptions): Promise<string>
}

interface Endpoint {
  url: string
  apiKey?: string
  apiSecret?: string
}

export interface AIConfig {
  url: string
  apiKey?: string
  apiSecret?: string
  chatModel?: string
  embeddingModel?: string
  /** Where embeddings go when it is not AI_URL. */
  embeddingEndpoint?: { url: string; apiKey?: string; apiSecret?: string }
  /** Second chat endpoint, tried when the first fails. */
  fallback?: { url: string; apiKey?: string; apiSecret?: string; chatModel: string }
}

/** With a fallback the first endpoint gets a shorter leash, so a hang costs seconds, not a minute. */
const PRIMARY_TIMEOUT_WITH_FALLBACK_MS = 25_000

export class AIClient {
  constructor(private readonly cfg: AIConfig) {}

  get chat(): Chat | null {
    const model = this.cfg.chatModel
    if (!model) return null
    return { model, complete: (m, o) => this.completeWithFallback(model, m, o) }
  }

  private async completeWithFallback(model: string, messages: ChatMessage[], o: ChatOptions = {}): Promise<string> {
    const fb = this.cfg.fallback
    if (!fb) return this.complete(this.endpoint(), model, messages, o)
    try {
      return await this.complete(this.endpoint(), model, messages, {
        ...o,
        signal: o.signal ?? AbortSignal.timeout(PRIMARY_TIMEOUT_WITH_FALLBACK_MS),
      })
    } catch (e) {
      if (o.signal?.aborted) throw e // the caller gave up: do not retry for them
      console.warn(`AI chat failed on the primary endpoint (${(e as Error).message}); trying the fallback`)
      return this.complete({ url: fb.url, apiKey: fb.apiKey, apiSecret: fb.apiSecret }, fb.chatModel, messages, o)
    }
  }

  private endpoint(): Endpoint {
    return { url: this.cfg.url, apiKey: this.cfg.apiKey, apiSecret: this.cfg.apiSecret }
  }

  get embedder(): Embedder | null {
    const model = this.cfg.embeddingModel
    return model ? { model, embed: (i) => this.embed(model, i) } : null
  }

  private headers(ep: Endpoint): Record<string, string> {
    const { apiKey, apiSecret } = ep
    const h: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
    if (apiKey && apiSecret) {
      h['api-key'] = apiKey
      h['api-secret'] = apiSecret
    } else if (apiKey) {
      h.authorization = `Bearer ${apiKey}`
    }
    return h
  }

  private async post<T>(ep: Endpoint, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(ep.url.replace(/\/+$/, '') + path, {
      method: 'POST',
      headers: this.headers(ep),
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(`AI ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return (await res.json()) as T
  }

  private async complete(ep: Endpoint, model: string, messages: ChatMessage[], o: ChatOptions = {}): Promise<string> {
    const r = await this.post<{ choices?: { message?: { content?: unknown } }[] }>(
      ep,
      '/chat/completions',
      {
        model,
        messages,
        stream: false,
        ...(o.maxTokens ? { max_tokens: o.maxTokens } : {}),
        ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
      },
      o.signal,
    )
    const content = r.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new Error('AI chat: empty response')
    return content
  }

  private async embed(model: string, input: string[]): Promise<number[][]> {
    const r = await this.post<{ data?: { index?: number; embedding: number[] }[] }>(this.cfg.embeddingEndpoint ?? this.endpoint(), '/embeddings', {
      model,
      input,
      encoding_format: 'float',
    })
    const data = [...(r.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    if (data.length !== input.length) throw new Error('AI embeddings: unexpected response')
    return data.map((d) => d.embedding)
  }
}

export function aiFromEnv(env: Record<string, string | undefined> = process.env): AIClient | null {
  if (!env.AI_URL) return null
  return new AIClient({
    url: env.AI_URL,
    apiKey: env.AI_API_KEY || undefined,
    apiSecret: env.AI_API_SECRET || undefined,
    chatModel: env.AI_CHAT_MODEL || undefined,
    embeddingModel: env.AI_EMBEDDING_MODEL || undefined,
    embeddingEndpoint: env.AI_EMBEDDING_URL
      ? {
          url: env.AI_EMBEDDING_URL,
          apiKey: env.AI_EMBEDDING_API_KEY || undefined,
          apiSecret: env.AI_EMBEDDING_API_SECRET || undefined,
        }
      : undefined,
    fallback:
      env.AI_FALLBACK_URL && env.AI_FALLBACK_CHAT_MODEL
        ? {
            url: env.AI_FALLBACK_URL,
            apiKey: env.AI_FALLBACK_API_KEY || undefined,
            apiSecret: env.AI_FALLBACK_API_SECRET || undefined,
            chatModel: env.AI_FALLBACK_CHAT_MODEL,
          }
        : undefined,
  })
}

/** Whether this server can answer questions (the assistant is only offered then). */
export function chatConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !!(env.AI_URL && env.AI_CHAT_MODEL)
}
