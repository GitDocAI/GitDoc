/**
 * Shim for `import.meta.env` which packages/ui references (Vite syntax).
 * The render-cli never executes those code paths, but tsc still typechecks
 * them transitively. This satisfies the type system without pulling in
 * `vite/client` types and their Vite-only globals.
 */
interface ImportMetaEnv {
  readonly [key: string]: string | undefined
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
