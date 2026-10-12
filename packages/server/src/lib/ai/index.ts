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

export interface AIConfig {
  url: string
  apiKey?: string
  apiSecret?: string
  chatModel?: string
  embeddingModel?: string
}

export class AIClient {
  constructor(private readonly cfg: AIConfig) {}

  get chat(): Chat | null {
    const model = this.cfg.chatModel
    return model ? { model, complete: (m, o) => this.complete(model, m, o) } : null
  }

  get embedder(): Embedder | null {
    const model = this.cfg.embeddingModel
    return model ? { model, embed: (i) => this.embed(model, i) } : null
  }

  private headers(): Record<string, string> {
    const { apiKey, apiSecret } = this.cfg
    const h: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
    if (apiKey && apiSecret) {
      h['api-key'] = apiKey
      h['api-secret'] = apiSecret
    } else if (apiKey) {
      h.authorization = `Bearer ${apiKey}`
    }
    return h
  }

  private async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(this.cfg.url.replace(/\/+$/, '') + path, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(`AI ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return (await res.json()) as T
  }

  private async complete(model: string, messages: ChatMessage[], o: ChatOptions = {}): Promise<string> {
    const r = await this.post<{ choices?: { message?: { content?: unknown } }[] }>(
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
    const r = await this.post<{ data?: { index?: number; embedding: number[] }[] }>('/embeddings', {
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
  })
}
