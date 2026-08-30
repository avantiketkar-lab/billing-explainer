/** Deterministic JSON: keys sorted at every level, so the hash is stable. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort()
    .map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k]))
    .join(',') + '}';
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const GENESIS_HASH = '0'.repeat(64);

/** entry_hash = sha256(prev_hash || canonical(entry)) */
export function chainHash(prevHash: string, entry: unknown): Promise<string> {
  return sha256Hex(prevHash + canonicalJson(entry));
}
