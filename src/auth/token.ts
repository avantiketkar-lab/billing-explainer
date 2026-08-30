import type { Principal, Role } from '../types';
import { canonicalJson } from '../audit/hash';

/**
 * Session tokens. HMAC-SHA256 over a canonical payload.
 *
 * In production this is replaced by Cloudflare Access (staff) and the billing
 * app's IdP (customers); the CLAIM SHAPE below is identical either way, which
 * is what makes the swap a configuration change rather than a rewrite.
 *
 * The property that matters: account_scope lives in the SIGNED token. It is
 * never read from a tool argument, never read from model output, and there is
 * no code path that widens it after the token is minted.
 */
export interface Claims {
  sub: string;
  role: Role;
  scope: string[];
  sid: string;
  jti: string;
  exp: number;
}

const b64u = {
  enc: (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/')),
};

async function key(secret: string) {
  // A missing binding would otherwise reach WebCrypto as a zero-length key and
  // surface as an opaque DataError. Fail with the fix instead.
  if (!secret) {
    throw new Error(
      'SESSION_SECRET is not set. Local dev: add SESSION_SECRET to .dev.vars. ' +
      'Deployed: wrangler secret put SESSION_SECRET',
    );
  }
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
}

export async function mint(claims: Claims, secret: string): Promise<string> {
  const body = b64u.enc(canonicalJson(claims));
  const sig = await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(body));
  const sigB64 = b64u.enc(String.fromCharCode(...new Uint8Array(sig)));
  return `${body}.${sigB64}`;
}

/**
 * Verified on EVERY tools/call, not once at connect. A long-lived MCP session
 * whose token was checked only at handshake keeps its privileges after the
 * principal's access is revoked, which is exactly the window an agent loop is
 * long enough to sit inside.
 */
export async function verify(token: string, secret: string): Promise<Principal> {
  const [body, sig] = token.split('.');
  if (!body || !sig) throw new Error('malformed token');
  const expected = await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(body));
  const expectedB64 = b64u.enc(String.fromCharCode(...new Uint8Array(expected)));
  // Constant-time-ish compare: equal length, full scan, no early return.
  if (sig.length !== expectedB64.length) throw new Error('bad signature');
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expectedB64.charCodeAt(i);
  if (diff !== 0) throw new Error('bad signature');

  const claims = JSON.parse(b64u.dec(body)) as Claims;
  if (claims.exp * 1000 < Date.now()) throw new Error('token expired');

  return Object.freeze({
    principal_id: claims.sub,
    role: claims.role,
    account_scope: Object.freeze([...claims.scope]),
    session_id: claims.sid,
    token_jti: claims.jti,
    exp: claims.exp,
  });
}
