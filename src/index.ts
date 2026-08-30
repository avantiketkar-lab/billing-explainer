import type { Env, Role } from './types';
import { BillingExplainerMCP } from './mcp/server';
import { AuditLog } from './audit/audit-do';
import { BillingAgent } from './agent/agent-do';
import { BillingInvestigation } from './agent/investigator-workflow';
import { DemoLimiter } from './limits/demo-limiter';
import { mint } from './auth/token';

export { BillingExplainerMCP, AuditLog, BillingAgent, BillingInvestigation, DemoLimiter };

const NORTHWIND = 'acct_01H8NORTHWIND';
const HARBORLIGHT = 'acct_02H8HARBORLIGHT';

/**
 * DEMO IDENTITY ONLY.
 *
 * In a real deployment the principal comes from Cloudflare Access (staff) or the
 * billing IdP (customers) and this function does not exist. The CLAIM SHAPE is
 * identical, so the swap is configuration rather than a rewrite — which is the
 * point of putting scope in a signed token in the first place.
 */
async function demoToken(role: Role, session: string, secret: string) {
  const scope = role === 'support_engineer' ? [NORTHWIND, HARBORLIGHT] : [NORTHWIND];
  return {
    scope,
    token: await mint(
      {
        sub: role === 'support_engineer' ? 'eng_demo_01' : 'cust_nw_01',
        role, scope, sid: session, jti: crypto.randomUUID(),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      secret,
    ),
  };
}

/**
 * Every /api route goes through here so a thrown error comes back as JSON.
 * Without it an exception is rendered as an HTML error page, and the browser
 * reports it as `Unexpected token '<'` — an error message that tells you
 * nothing about what actually broke.
 */
async function json(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (err) {
    return Response.json(
      { error: (err as Error).message ?? 'unknown error' },
      { status: 500 },
    );
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/healthz') return new Response('ok');

    if (url.pathname === '/audit/verify') {
      const stub = env.AUDIT.get(env.AUDIT.idFromName('global')) as any;
      return Response.json(await stub.verify());
    }

    // ---- MCP transport ----------------------------------------------------
    if (url.pathname.startsWith('/mcp')) {
      const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      // Props are attached to the REAL ExecutionContext. Spreading ctx into a
      // plain object loses waitUntil/passThroughOnException and the agent
      // runtime throws — which surfaces to the browser as an HTML error page
      // and a very unhelpful "Unexpected token '<'" in the chat client.
      (ctx as ExecutionContext & { props?: unknown }).props = {
        token, publicBase: url.origin,
      };
      return BillingExplainerMCP.serve('/mcp', { binding: 'MCP_AGENT' }).fetch(req, env as any, ctx);
    }

    // ---- Chat API ---------------------------------------------------------
    if (url.pathname === '/api/manifest') {
      return json(async () => {
        const role = (url.searchParams.get('role') ?? 'customer') as Role;
        const session = url.searchParams.get('session') ?? crypto.randomUUID();
        const { token, scope } = await demoToken(role, session, env.SESSION_SECRET);
        const agent = env.AGENT.get(env.AGENT.idFromName(session)) as any;
        // The manifest is whatever the SERVER decides this token may see — the
        // UI renders it rather than deciding it, so the panel is evidence.
        const tools = await agent.manifest(token, `${url.origin}/mcp`);
        return Response.json({ tools, scope });
      });
    }

    // Start the investigation and return an id. The handler does NOT wait for
    // the workflow; waiting in a request is what the runtime kills.
    if (url.pathname === '/api/ask' && req.method === 'POST') {
      return json(async () => {
        // The deployed demo is public and every investigation spends real
        // Workers AI quota on the owner's account. Reads stay uncapped.
        const limiter = env.LIMITER.get(env.LIMITER.idFromName('global')) as any;
        const gate = await limiter.check();
        if (!gate.allowed) {
          return Response.json(
            { error: `Demo rate limit reached (${gate.resetsInSeconds}s until reset). `
                   + `This is a public demo running on a personal Cloudflare account; `
                   + `model-backed requests are capped so it stays available.` },
            { status: 429 },
          );
        }

        const body = await req.json() as any;
        const role = (body.role ?? 'customer') as Role;
        const session = body.session ?? crypto.randomUUID();
        const { token } = await demoToken(role, session, env.SESSION_SECRET);
        const agent = env.AGENT.get(env.AGENT.idFromName(session)) as any;
        const started = await agent.start({
          token,
          question: body.question,
          identifier: body.identifier,
          period_a: body.period_a,
          period_b: body.period_b,
          mcpUrl: `${url.origin}/mcp`,
        });
        return Response.json(started);
      });
    }

    if (url.pathname === '/api/status') {
      return json(async () => {
        const role = (url.searchParams.get('role') ?? 'customer') as Role;
        const session = url.searchParams.get('session') ?? '';
        const instanceId = url.searchParams.get('instance_id') ?? '';
        const { token } = await demoToken(role, session, env.SESSION_SECRET);
        const agent = env.AGENT.get(env.AGENT.idFromName(session)) as any;
        return Response.json(await agent.poll(token, instanceId));
      });
    }

    // ---- Out-of-band approval --------------------------------------------
    if (url.pathname.startsWith('/approve/')) {
      // Deliberately NOT reachable from the MCP surface. A separate identity, a
      // separate session and a separate code path — that separation is the
      // control, not a confirmation dialog.
      const proposalId = url.pathname.split('/')[2];
      const hasToken = Boolean(url.searchParams.get('t'));
      return new Response(
        `Approval surface for proposal ${proposalId} (token ${hasToken ? 'present' : 'missing'}).\n` +
        `POST to approve. The approving principal must differ from the proposing principal;\n` +
        `enforced by a CHECK constraint on credit_proposals, not by this page.\n` +
        `Cloudflare Access goes in front of this route in a real deployment.`,
        { headers: { 'content-type': 'text/plain' } },
      );
    }

    // ---- Static chat page -------------------------------------------------
    return env.ASSETS.fetch(req);
  },
};
