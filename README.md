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

## Search

The search box works out of the box: pages are indexed when you publish, with a built-in BM25 index (title weighs double, prefixes match as you type, accents are folded). Nothing to run.

For larger sites, or if you already operate OpenSearch, point the server at it:

| Variable | Meaning |
|---|---|
| `SEARCH_BACKEND` | `embedded` or `opensearch`. Default: `opensearch` if `OPENSEARCH_URL` is set, else `embedded`. |
| `OPENSEARCH_URL` | e.g. `http://opensearch:9200` (credentials may be in the URL). |
| `OPENSEARCH_USERNAME`, `OPENSEARCH_PASSWORD` | Basic auth. |
| `OPENSEARCH_INSECURE` | `true` to accept a self-signed certificate. |
| `EMBEDDINGS_URL`, `EMBEDDINGS_MODEL`, `EMBEDDINGS_API_KEY` | Any OpenAI-compatible embeddings API (OpenAI, Ollama's `/v1`, vLLM…). Turns on hybrid text + vector search. OpenSearch only. |

`docker compose --profile opensearch up -d` (in `deploy/selfhost`) also starts a single-node OpenSearch on the compose network.

The OpenSearch adapter uses the same index name (`doc_{org}_{doc}`), document fields, mapping and query as the hosted product, so an index written by one is readable by the other. If the search backend is down while you publish, the site still goes live and the publish response carries a `search.error`.

Add another engine by implementing `SearchBackend` (`packages/server/src/lib/search/types.ts`): `replace`, `remove`, `search`.

## Known limitations

- **"Ask AI" is not available in this build.** It needs a language model and a retrieval backend that are not part of this repository; the search box (see [Search](#search)) works.
- **Private sites need an identity provider** you run yourself (see `DOCS_PRIVATE`).
- The package is alpha: the HTTP API and the on-disk format may still change.

## License

[GNU AGPL-3.0](LICENSE). Third-party assets (icon fonts in `packages/server/public/vendor`) keep their own licenses; see [NOTICE](NOTICE).
