/**
 * AI-crawler detection for Agent Analytics ("which AI agents read your
 * documentation"). Matches the User-Agent header against known AI crawler
 * signatures — this works on every Cloudflare plan (Free included), unlike
 * `request.cf.botManagement` which needs Cloudflare's Bot Management
 * product. Not exhaustive; extend the list as new crawlers show up.
 */
const AI_CRAWLER_SIGNATURES: Array<{ match: string; name: string }> = [
  { match: 'gptbot', name: 'GPTBot (OpenAI)' },
  { match: 'oai-searchbot', name: 'OAI-SearchBot (OpenAI)' },
  { match: 'chatgpt-user', name: 'ChatGPT-User (OpenAI)' },
  { match: 'claudebot', name: 'ClaudeBot (Anthropic)' },
  { match: 'claude-web', name: 'Claude-Web (Anthropic)' },
  { match: 'anthropic-ai', name: 'Anthropic-AI' },
  { match: 'perplexitybot', name: 'PerplexityBot' },
  { match: 'perplexity-user', name: 'Perplexity-User' },
  { match: 'google-extended', name: 'Google-Extended' },
  { match: 'bytespider', name: 'Bytespider (ByteDance)' },
  { match: 'ccbot', name: 'CCBot (Common Crawl)' },
  { match: 'applebot-extended', name: 'Applebot-Extended (Apple)' },
  { match: 'amazonbot', name: 'Amazonbot' },
  { match: 'meta-externalagent', name: 'Meta-ExternalAgent' },
  { match: 'diffbot', name: 'Diffbot' },
  { match: 'youbot', name: 'YouBot (You.com)' },
  { match: 'cohere-ai', name: 'Cohere-AI' },
  { match: 'ai2bot', name: 'AI2Bot (Allen Institute)' },
  { match: 'mistralai-user', name: 'MistralAI-User' },
]

/**
 * Returns a display name (e.g. "GPTBot (OpenAI)") for a known AI crawler,
 * or null for a regular browser/human visitor (or an unrecognized bot —
 * classic search-engine crawlers like plain Googlebot/Bingbot are
 * intentionally excluded, they're not "AI agents" for this feature).
 */
export function detectAIBot(userAgent: string | null): string | null {
  if (!userAgent) return null
  const ua = userAgent.toLowerCase()
  for (const { match, name } of AI_CRAWLER_SIGNATURES) {
    if (ua.includes(match)) return name
  }
  return null
}
