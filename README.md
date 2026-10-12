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
| `ADMIN_PORT`, `ADMIN_HOST` | Admin panel address (default `8081` on `127.0.0.1`; the image listens on `0.0.0.0` inside the container). `ADMIN_ENABLED=false` turns it off. |
| `ADMIN_PASSWORD` | Preset the panel password and skip onboarding. |
| `PUBLIC_URL` | Prefills the address shown in the panel's connect commands. |
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

## The admin panel

A second port, **8081**, serves an administration panel and the operator API. It is separate from the port readers use, and bound to `127.0.0.1` (compose publishes it only on the host's loopback), so by default it is not reachable from the network. Open `http://127.0.0.1:8081`:

1. **First run:** it asks for an admin password, proving you control the server with the `PUBLISH_TOKEN`. (`ADMIN_PASSWORD` in the environment skips this step for automated installs.)
2. **Connect:** copy-paste commands to install the CLI, connect it to this server, publish, install the AI skill and add the MCP server.
3. **Sites:** each documentation, with its search status and usage. Per site: **Access** (sign-in providers and who may read), **Quotas**, rebuild the search index, and the commands to publish or connect an agent.
4. **Server:** what this installation is configured with (AI, search backend, events). Secrets are never shown.

The panel is for administration only. Content is files: you edit it with your editor or your AI assistant, and publish with the CLI.

To reach the panel from another machine, use an SSH tunnel (`ssh -L 8081:127.0.0.1:8081 server`) or put it behind your VPN or an authenticating reverse proxy. Do not publish it on the internet.

## Per-site settings

Some things are not for the docs author and not for the environment: they belong to whoever **operates** the server, and they change while it runs. Those are *site settings*, stored in the data volume (`_settings/`), never inside the docs repo. The admin panel edits them; automation (a control plane, a script) uses the same API on the admin port with `Authorization: Bearer $PUBLISH_TOKEN`:

```bash
ADMIN=http://127.0.0.1:8081
# what a site has set, and what is in force (its own values over the instance defaults)
curl -H "Authorization: Bearer $PUBLISH_TOKEN" "$ADMIN/api/settings?hostname=docs.acme.com"

# 200 questions a day, 3000 a month, 5 per visitor per minute; null = no limit, 0 = closed
curl -X PUT -H "Authorization: Bearer $PUBLISH_TOKEN" -H "Content-Type: application/json" \
  -d '{"quota": {"ask_per_day": 200, "ask_per_month": 3000, "ask_per_min_per_visitor": 5}}' \
  "$ADMIN/api/settings?hostname=docs.acme.com"

# what it has consumed
curl -H "Authorization: Bearer $PUBLISH_TOKEN" "$ADMIN/api/usage?hostname=docs.acme.com"
```

| Quota | Meaning | Default |
|---|---|---|
| `ask_per_day` | Questions to the assistant per documentation per day (UTC) | `ASK_DAILY_LIMIT`, 1000 |
| `ask_per_month` | Same, per calendar month | `ASK_MONTHLY_LIMIT`, none |
| `ask_per_min_per_visitor` | Questions per visitor per minute | `RATE_ASK_PER_MIN`, 10 |
| `search_per_min_per_visitor` | Searches (and MCP calls) per visitor per minute | `RATE_SEARCH_PER_MIN`, 120 |

A change applies within seconds, without a restart. When the allowance is spent, `/api/ask` answers `429` with `{"code": "quota_exceeded", "limit", "period"}`. Counters survive restarts. A hosted control plane uses this same API to apply a plan's limits and to read usage for billing: the engine never calls a billing service per request.

### Private sites: who may read

A site becomes private when its operator turns sign-in on. Like quotas, this is a site setting (secrets included), never part of the docs. The login page offers every provider you list, in order.

```bash
curl -X PUT -H "Authorization: Bearer $PUBLISH_TOKEN" -H "Content-Type: application/json" \
  "$ADMIN/api/settings?hostname=docs.acme.com" -d '{
  "auth": {
    "enabled": true,
    "providers": [
      { "id": "okta", "type": "oidc", "name": "Okta",
        "issuer": "https://acme.okta.com", "client_id": "…", "client_secret": "…" },
      { "id": "team", "type": "password", "name": "Team password", "password": "a long shared password" }
    ],
    "allow": { "email_domains": ["acme.com"], "emails": ["partner@example.org"], "groups": ["docs-readers"] },
    "session_hours": 24
  }
}'
```

| Provider | What it is |
|---|---|
| `oidc` | Any OpenID Connect provider (Okta, Entra ID, Auth0, Google, Keycloak…): authorization code flow with PKCE. Register `https://<your host>/api/auth/oidc/callback` as the redirect URI. Needs an `email` claim. |
| `password` | One shared password, stored as a scrypt hash. Changing it ends the sessions made with the old one. Attempts are throttled. |
| `gitdocai` | The hosted product's IAM: `{ "type": "gitdocai", "iam_url": "https://…" }`. Tokens are verified against its JWKS. |

`allow` applies to `oidc` identities: an email, an email domain, or a group (from the `groups` claim, or `groups_claim`) lets a reader in; with no rules, anyone the provider vouches for is let in. The password is the access, so `allow` does not apply to it.

Secrets are write-only: reading the settings shows `***`, and sending `***` (or omitting it) keeps the stored value. Sessions are signed cookies; set `SESSION_SECRET`, or one is generated into `_secrets/` in the data volume. Behind a proxy, set `TRUST_PROXY=true` so redirect URIs use the right scheme. The same login protects the search, assistant and MCP endpoints.

## Behind a CDN

The server sends `Cache-Control: public, max-age=60, stale-while-revalidate=600` for public pages and `private, no-store` for private ones, so a CDN in front (Cloudflare, for instance, with a cache rule that respects origin headers) serves most traffic. Set `TRUST_PROXY=true` so rate limits count real visitors and the country in analytics comes from `CF-IPCountry`. Do not set it when the server is reachable without the proxy: those headers can then be forged.

`POST /api/reindex[?hostname=…]` on the admin port (Bearer `PUBLISH_TOKEN`) rebuilds the search index from the files already on disk and drops the caches. It is for setups where another process writes the site into the data volume instead of calling `/api/publish`.

## Known limitations

- **Private sites need an identity provider** you run yourself (see `DOCS_PRIVATE`).
- The package is alpha: the HTTP API and the on-disk format may still change.

## License

[GNU AGPL-3.0](LICENSE). Third-party assets (icon fonts in `packages/server/public/vendor`) keep their own licenses; see [NOTICE](NOTICE).
