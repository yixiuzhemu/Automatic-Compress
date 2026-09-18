import { rm } from 'node:fs/promises'

await rm('lib', { recursive: true, force: true })
await rm('client', { recursive: true, force: true })
