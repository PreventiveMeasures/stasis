import { compress } from '@preventive/archive/compression.js'
import { pack } from '@preventive/archive/tar.js'

// A .stasis.tgz's bytes, as `tar -czf` packs `files` (path -> text or bytes).
export const tgzOf = async (files) => Buffer.from(await compress(pack(Object.entries(files).map(([name, data]) =>
  ({ name, data: typeof data === 'string' ? new TextEncoder().encode(data) : data }))), 'gzip'))
