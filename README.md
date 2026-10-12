# gitdoc

The open-source engine behind GitDocAI documentation sites: it renders a folder of Markdown/MDX files and serves them, on your own server.

A documentation site is a folder (`gitdocai.json`, one `.mdx` file per page, an `assets/` directory) that you keep in git. The [`gitdoc` CLI](https://github.com/GitDocAI/gitdocai-cli) creates and previews it; this repository is what renders and serves it.

```
your folder ──gitdoc publish──▶ POST /api/publish ──▶ render ──▶ DATA_DIR ──▶ readers
```

## What is here

| Package | What it does |
|---|---|
| [`packages/server`](packages/server) | Serves published sites (Astro, on Node) and accepts publishes over HTTP |
| [`packages/render`](packages/render) | Turns MDX pages into HTML and writes the published bundle to a directory |
| [`packages/ui`](packages/ui) | The MDX parser, serializer and block presenters the renderer uses, plus the content styles |
| [`deploy/selfhost`](deploy/selfhost) | A Dockerfile and compose file to run it |

## Run it

```bash
cd deploy/selfhost
cp .env.example .env          # set PUBLISH_TOKEN  (openssl rand -hex 24)
docker compose up -d --build  # http://localhost:8080
```

Then, from a docs folder:

```bash
gitdoc connect http://localhost:8080 --token <PUBLISH_TOKEN>
gitdoc publish
```

### Several sites on one server

A server hosts any number of documentations. Each answers on its own **hostname** (`<name>.localhost` locally, your domain in production: `gitdoc publish --hostname docs.acme.com`). With a single site published the server answers on any host; with several, an unknown host gets a 404 that lists the hostnames that exist.

To show the assistant panel, enable it in `gitdocai.json`:

```json
{ "assistant": { "enabled": true, "custom_instructions": "Answer briefly." } }
```

### Configuration

| Variable | Meaning |
|---|---|
| `PUBLISH_TOKEN` | Token accepted by `POST /api/publish` and `GET /api/sites`. Publishing is disabled without it |
| `DATA_DIR` | Where published sites are stored (default `./data`) |
| `SINGLE_SITE` | `true`: answer on any host while exactly one site is published |
| `LIST_SITES` | `true`: a 404 page lists the hostnames hosted here |
| `PUBLISH_MAX_MB` | Largest accepted upload (default 200) |
| `DOCS_PRIVATE` | `true` publishes sites as private. **This needs an identity provider (`IAM_URL`, `JWT_ISSUER`); without one nobody can sign in** |

## The engine

`npm run build` assembles `engine/`: a self-contained directory (~17 MB, no `node_modules`) that runs from anywhere:

```
engine/server/entry.mjs     the server
engine/render.js            the renderer
```

It is what the Docker image ships and what `gitdoc dev` runs. To use it with the CLI:

```bash
export GITDOC_ENGINE_SERVER=$PWD/engine/server/entry.mjs
export GITDOC_ENGINE_RENDER=$PWD/engine/render.js
```

## Development

Building needs Node.js 22.12 or later (Astro 7); the built engine also runs on Node 20.

```bash
npm install
npm run build
npm test        # starts the real server and publishes through its HTTP API
```

## Search, assistant and agents

**Search** works out of the box. Pages are indexed when you publish, with a built-in BM25 index (title weighs double, prefixes match as you type, accents are folded). Nothing to run.

**Meaning-based search.** Point the server at an embeddings model and the same built-in index also keeps vectors for every passage and fuses both rankings (reciprocal rank fusion). A search for "containers" finds the page about Docker. Documentation sites are small enough that exact in-process cosine takes milliseconds, so no vector database is needed.

**Ask (assistant).** With a chat model configured, `/api/ask` answers readers' questions from the docs: it retrieves the best passages, answers only from them, in the reader's language, and cites its sources. The documentation owner's `custom_instructions` come from the published config, never from the request, and the excerpts are fenced as data against prompt injection.

**Agents.** `/api/mcp` is a read-only [MCP](https://modelcontextprotocol.io) server (`search_docs`, `read_page`, `list_pages`): `claude mcp add --transport http docs https://docs.example.com/api/mcp`. Every page is also available as Markdown (`<page>.md`) and in `/llms.txt`.

### Configuration

| Variable | Meaning |
|---|---|
| `AI_URL` | Base URL of any OpenAI-compatible API (ThreatWinds, OpenAI, Ollama `/v1`, vLLM…). |
| `AI_API_KEY`, `AI_API_SECRET` | Key alone → `Authorization: Bearer`. Both → `api-key` / `api-secret` headers (ThreatWinds). |
| `AI_EMBEDDING_MODEL` | Turns on meaning-based search. |
| `AI_CHAT_MODEL` | Turns on Ask. |
| `AI_MAX_ANSWER_TOKENS` | Answer length cap (default 800). |
| `SEARCH_MIN_SIMILARITY` | Passages less similar than this are ignored (default 0.3). |
| `SEARCH_BACKEND` | `embedded` or `opensearch`. Default: `opensearch` if `OPENSEARCH_URL` is set. |
| `OPENSEARCH_URL`, `OPENSEARCH_USERNAME`, `OPENSEARCH_PASSWORD`, `OPENSEARCH_INSECURE` | Use OpenSearch instead of the built-in index. |
| `RATE_SEARCH_PER_MIN`, `RATE_ASK_PER_MIN`, `ASK_DAILY_LIMIT` | Limits (defaults 120, 10, 1000). Ask costs money: keep a cap. |
| `TRUST_PROXY` | `true` behind a proxy/CDN so limits count real visitors. |
| `EVENTS`, `EVENTS_URL`, `EVENTS_TOKEN` | Record page views, searches and questions (`file` or an HTTP endpoint). Off by default; no IP is stored. |

### OpenSearch

You do not need it for a documentation site. Use it for a very large corpus, to share one index between servers, or if you already run it. It is an optional, commented service in `deploy/selfhost/docker-compose.yml`. The adapter uses the same index name (`doc_{org}_{doc}`), fields, mapping and query as the hosted product, so an index written by one is readable by the other.

If the search backend or the model is down while you publish, the site still goes live and the publish response carries a `search.error` / `search.warning`. If the model is down at query time, search falls back to text.

Add another engine by implementing `SearchBackend` (`packages/server/src/lib/search/types.ts`): `replace`, `remove`, `search`, `passages`.

### Privacy

With a hosted model, the passages used to answer a question leave your server. For private documentation, use a model you host.

## Per-site settings

Some things are not for the docs author and not for the environment: they belong to whoever **operates** the server, and they change while it runs. Those are *site settings*, stored in the data volume (`_settings/`), never inside the docs repo, and changed through the admin API with the same `PUBLISH_TOKEN`:

```bash
# what a site has set, and what is in force (its own values over the instance defaults)
curl -H "Authorization: Bearer $PUBLISH_TOKEN" "$URL/api/settings?hostname=docs.acme.com"

# 200 questions a day, 3000 a month, 5 per visitor per minute; null = no limit, 0 = closed
curl -X PUT -H "Authorization: Bearer $PUBLISH_TOKEN" -H "Content-Type: application/json" \
  -d '{"quota": {"ask_per_day": 200, "ask_per_month": 3000, "ask_per_min_per_visitor": 5}}' \
  "$URL/api/settings?hostname=docs.acme.com"

# what it has consumed
curl -H "Authorization: Bearer $PUBLISH_TOKEN" "$URL/api/usage?hostname=docs.acme.com"
```

| Quota | Meaning | Default |
|---|---|---|
| `ask_per_day` | Questions to the assistant per documentation per day (UTC) | `ASK_DAILY_LIMIT`, 1000 |
| `ask_per_month` | Same, per calendar month | `ASK_MONTHLY_LIMIT`, none |
| `ask_per_min_per_visitor` | Questions per visitor per minute | `RATE_ASK_PER_MIN`, 10 |
| `search_per_min_per_visitor` | Searches (and MCP calls) per visitor per minute | `RATE_SEARCH_PER_MIN`, 120 |

A change applies within seconds, without a restart. When the allowance is spent, `/api/ask` answers `429` with `{"code": "quota_exceeded", "limit", "period"}`. Counters survive restarts. A hosted control plane uses this same API to apply a plan's limits and to read usage for billing: the engine never calls a billing service per request.

## Behind a CDN

The server sends `Cache-Control: public, max-age=60, stale-while-revalidate=600` for public pages and `private, no-store` for private ones, so a CDN in front (Cloudflare, for instance, with a cache rule that respects origin headers) serves most traffic. Set `TRUST_PROXY=true` so rate limits count real visitors and the country in analytics comes from `CF-IPCountry`. Do not set it when the server is reachable without the proxy: those headers can then be forged.

`POST /api/reindex[?hostname=…]` (Bearer `PUBLISH_TOKEN`) rebuilds the search index from the files already on disk and drops the caches. It is for setups where another process writes the site into the data volume instead of calling `/api/publish`.

## Known limitations

- **Private sites need an identity provider** you run yourself (see `DOCS_PRIVATE`).
- The package is alpha: the HTTP API and the on-disk format may still change.

## License

[GNU AGPL-3.0](LICENSE). Third-party assets (icon fonts in `packages/server/public/vendor`) keep their own licenses; see [NOTICE](NOTICE).
