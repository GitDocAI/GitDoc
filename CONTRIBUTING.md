# Contributing

Thanks for helping. This repository is the GitDoc engine: the server that
serves published documentation, the renderer, and the admin panel.

## Set up

```bash
npm ci
npm run build      # needs Node >= 22.12
npm test           # starts the real server and publishes to it
```

The built engine (`engine/`) also runs on Node 20. `GITDOC_TEST_OPENSEARCH_URL`
enables the tests that run against a real OpenSearch.

## Changing things

- Keep a change focused, with a test that fails without it. The tests in
  `test/engine.test.mjs` start the server for real; add yours there.
- Anything that touches who can read a private site (auth, sessions, the
  middleware) needs a test that proves the unauthenticated case.
- Settings and secrets that belong to the operator go in site settings
  (`packages/server/src/lib/settings.ts`), not in the docs and not in
  environment variables per site.
- New search or AI backends implement the interfaces in
  `packages/server/src/lib/search/types.ts` and
  `packages/server/src/lib/ai/index.ts`.

## Releasing

Publish a GitHub Release (tag `v<version>`). One workflow does the rest: it
builds and tests, publishes `@gitdocai/engine` to npm, and pushes
`ghcr.io/gitdocai/gitdoc-server` with the same version. It needs the
`NPM_TOKEN` repository secret. A release marked as pre-release goes to the
`next` dist-tag instead of `latest`.

## Licensing

The code in this repository is licensed under AGPL-3.0-only. By submitting a
contribution you state that you have the right to do so and that it may be
distributed under that license.

The name "GitDoc"/"GitDocAI" and the logo are trademarks and are not licensed
by the AGPL (see `NOTICE`).
