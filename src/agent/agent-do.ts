import { DurableObject } from 'cloudflare:workers';
import type { Env, Principal } from '../types';
import { verify as verifyToken } from '../auth/token';
import { McpToolClient } from './mcp-client';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  trace?: Array<{ tool: string; args: unknown; ms: number }>;
  withheld?: boolean;
  problems?: string[];
  at: string;
}

function describeError(err: unknown): string {
  if (!err) return '';
  if (typeof err === 'string') return err;
  const e = err as { message?: string; name?: string };
  if (e.message) return e.name ? `${e.name}: ${e.message}` : e.message;
  try { return JSON.stringify(err); } catch { return 'unknown error'; }
}

export type AskState =
  | { state: 'running'; instance_id: string }
  | { state: 'done'; turn: Turn }
  | { state: 'failed'; turn: Turn };

/**
 * BillingAgent — one Durable Object per chat session.
 *
 * SESSION STATE, and the reason this is a DO rather than a stateless handler:
 *
 *  - The PRINCIPAL is bound once, on first use, and is immutable for the life
 *    of the object. There is no setter. Nothing the model emits, and nothing in
 *    a later request body, can change who this session is.
 *  - The conversation and the tool-call trace persist across turns, which is
 *    the "memory or state" the assignment asks for and is what makes the trace
 *    panel possible.
 *
 * ON NOT POLLING: an earlier version awaited the workflow to completion inside
 * `ask()`, sleeping in a loop. The Workers runtime killed the request — "your
 * Worker's code had hung and would never generate a response" — which is the
 * correct verdict: a request handler is not a place to wait on a long job.
 * `start()` returns an instance id immediately and the client polls `poll()`.
 */
export class BillingAgent extends DurableObject<Env> {
  async #bind(token: string): Promise<Principal> {
    const verified = await verifyToken(token, this.env.SESSION_SECRET);
    const stored = await this.ctx.storage.get<Principal>('principal');
    if (!stored) {
      await this.ctx.storage.put('principal', verified);
      return verified;
    }
    // A token for a different principal on an existing session is a bug or an
    // attack; either way it is not something we quietly accept.
    if (stored.principal_id !== verified.principal_id || stored.session_id !== verified.session_id) {
      throw new Error('session principal mismatch');
    }
    return stored;
  }

  async history(): Promise<Turn[]> {
    return (await this.ctx.storage.get<Turn[]>('turns')) ?? [];
  }

  /** The manifest this session is actually allowed to see, for the UI panel. */
  async manifest(token: string, mcpUrl: string) {
    await this.#bind(token);
    return new McpToolClient(mcpUrl, token).listTools();
  }

  /** Kick off the investigation and return immediately. */
  async start(input: {
    token: string; question: string; identifier: string;
    period_a: string; period_b: string; mcpUrl: string;
  }): Promise<{ instance_id: string }> {
    const principal = await this.#bind(input.token);

    const turns = await this.history();
    turns.push({ role: 'user', content: input.question, at: new Date().toISOString() });
    await this.ctx.storage.put('turns', turns);

    const instance = await this.env.INVESTIGATION.create({
      params: {
        question: input.question,
        identifier: input.identifier,
        period_a: input.period_a,
        period_b: input.period_b,
        token: input.token,          // the caller's own scope, carried forward
        role: principal.role,
        mcpUrl: input.mcpUrl,
      },
    });

    await this.ctx.storage.put('pending_instance', instance.id);
    return { instance_id: instance.id };
  }

  /** One non-blocking check. The client calls this on an interval. */
  async poll(token: string, instanceId: string): Promise<AskState> {
    await this.#bind(token);

    const instance = await this.env.INVESTIGATION.get(instanceId);
    const status = await instance.status();

    if (status.status === 'queued' || status.status === 'running' || status.status === 'waiting') {
      return { state: 'running', instance_id: instanceId };
    }

    if (status.status !== 'complete') {
      // status.error is an object, not a string — String() on it yields
      // "[object Object]", which is worse than no message at all.
      const detail = describeError(status.error);
      const turn: Turn = {
        role: 'assistant',
        content:
          `The investigation ended without an answer (status: ${status.status}).\n` +
          `Nothing is being shown rather than showing something unverified.` +
          (detail ? `\n\n${detail}` : ''),
        at: new Date().toISOString(),
        withheld: true,
        problems: detail ? [detail] : [],
      };
      await this.#append(turn);
      return { state: 'failed', turn };
    }

    const out = status.output as any;
    const turn: Turn = {
      role: 'assistant',
      content: out.answer,
      trace: out.trace,
      withheld: out.withheld,
      problems: out.validation?.problems ?? [],
      at: new Date().toISOString(),
    };
    await this.#append(turn);
    await this.ctx.storage.delete('pending_instance');
    return { state: 'done', turn };
  }

  async #append(turn: Turn) {
    const turns = await this.history();
    // Idempotent: polling twice after completion must not duplicate the turn.
    const last = turns[turns.length - 1];
    if (last?.role === 'assistant' && last.content === turn.content) return;
    turns.push(turn);
    await this.ctx.storage.put('turns', turns);
  }
}
