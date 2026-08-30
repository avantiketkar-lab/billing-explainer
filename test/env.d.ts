import type { Env } from '../src/types';

declare module 'cloudflare:test' {
  // Gives `env` in tests the real binding types instead of a bare ProvidedEnv.
  interface ProvidedEnv extends Env {}
}
