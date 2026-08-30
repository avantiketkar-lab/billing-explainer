import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';

/**
 * DemoLimiter — a fixed-window cap on model-backed requests.
 *
 * Why this exists: the deployed demo is a PUBLIC URL that calls Workers AI on
 * the owner's account. Every investigation spends real inference quota, so
 * without a cap one crawler, one impatient reviewer, or one loop in someone
 * else's script exhausts the daily allocation and the demo is dead for
 * everyone who arrives after them.
 *
 * A Durable Object rather than in-memory counters because Workers are not one
 * process: an isolate-local counter resets whenever the runtime feels like it,
 * which is a rate limit in appearance only.
 *
 * Deliberately crude — a fixed window, one global bucket, no per-IP fairness.
 * The goal is to keep a demo alive, not to be a rate-limiting service.
 */
const WINDOW_MS = 60 * 60 * 1000;   // 1 hour
const MAX_IN_WINDOW = 40;           // model-backed investigations per hour

export class DemoLimiter extends DurableObject<Env> {
  async check(): Promise<{ allowed: boolean; remaining: number; resetsInSeconds: number }> {
    const now = Date.now();
    const state = (await this.ctx.storage.get<{ windowStart: number; count: number }>('w'))
      ?? { windowStart: now, count: 0 };

    if (now - state.windowStart >= WINDOW_MS) {
      state.windowStart = now;
      state.count = 0;
    }

    const resetsInSeconds = Math.ceil((state.windowStart + WINDOW_MS - now) / 1000);

    if (state.count >= MAX_IN_WINDOW) {
      return { allowed: false, remaining: 0, resetsInSeconds };
    }

    state.count += 1;
    await this.ctx.storage.put('w', state);
    return { allowed: true, remaining: MAX_IN_WINDOW - state.count, resetsInSeconds };
  }
}
