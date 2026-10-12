#!/usr/bin/env node
import { runPublish } from './commands/publish'
import { runDev } from './commands/dev'
import type { PublishInput } from './types'

const USAGE = `Usage: gitdoc-render <command>

Commands:
  dev [dir] [--port N]
                    Local preview of a docs folder (gitdocai.json + .mdx),
                    with live reload. Default dir: current directory.
  publish           Read a PublishInput JSON from stdin, render + upload,
                    emit a PublishResult JSON to stdout.

Environment:
  --                All inputs come via stdin. Errors print to stderr,
                    result prints to stdout. Exit 0 on ok/partial, 1 on
                    failed/crash.
`

async function main(): Promise<number> {
  const command = process.argv[2]

  if (!command || command === '-h' || command === '--help') {
    process.stdout.write(USAGE)
    return 0
  }

  if (command === 'dev') {
    return runDev(process.argv.slice(3))
  }

  if (command === 'publish') {
    const input = await readStdinJson<PublishInput>()
    const result = await runPublish(input)
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    return result.status === 'failed' ? 1 : 0
  }

  process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`)
  return 2
}

async function readStdinJson<T>(): Promise<T> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim()
  if (!raw) throw new Error('no input on stdin')
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    throw new Error(`invalid JSON on stdin: ${(err as Error).message}`)
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`gitdoc-render crashed: ${message}\n`)
    process.exit(1)
  })
