/// <reference types="astro/client" />

import type { BucketLike, KVLike } from './lib/storage'

/** What the pages and routes read from `Astro.locals.runtime` (see middleware.ts). */
interface Runtime {
  env: {
    DOCS_R2: BucketLike
    DOMAINS_KV: KVLike
    // Self-hosted configuration (process.env).
    DATA_DIR?: string
    SINGLE_SITE?: string
    LIST_SITES?: string
    PUBLISH_TOKEN?: string
    DEV_HOSTNAME?: string
    // Optional integrations: leave unset to run standalone.
    IAM_URL?: string
    JWT_ISSUER?: string
    CONTENT_RUNTIME_URL?: string
    PUBLISH_WEB_CLIENT_ID?: string
    PUBLISH_WEB_CLIENT_SECRET?: string
    [key: string]: unknown
  }
  ctx: { waitUntil(promise: Promise<unknown>): void }
  cf?: { country?: string; region?: string }
}

declare namespace App {
  interface Locals {
    runtime: Runtime
    // Set by src/middleware.ts so routes don't re-resolve.
    docMapping?: import('./lib/types').DomainMapping | null
    session?: import('./lib/auth').SessionClaims | null
    otherOrgSession?: import('./lib/auth').SessionClaims | null
  }
}
