import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Env } from '../types';
import { verify as verifyToken } from '../auth/token';
import { toolsForRole } from './registry';
import { withAudit, dispatch } from './guard';

type Props = { token: string; publicBase: string } & Record<string, unknown>;

/**
 * A THIN ADAPTER over the enforcement path in ./guard.ts.
 *
 * Everything that decides whether a call is allowed lives in `withAudit`, which
 * has no dependency on the MCP SDK and is tested directly. This class only
 * translates protocol into that call — which is the right split, because a
 * security boundary you can only exercise by booting a protocol server is one
 * that in practice does not get exercised.
 */
export class BillingExplainerMCP extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: 'billing-explainer', version: '0.1.0' });

  /** Props are bound to the session by the transport; never by tool input. */
  #props(): Props {
    const p = this.props as Props | undefined;
    if (!p?.token) throw new Error('missing session token');
    return p;
  }

  async init() {
    // ROLE-SCOPED MANIFEST. The principal is resolved here, at session
    // construction, and the manifest is built from its role — so a customer
    // session never has propose_credit registered and it cannot appear in
    // tools/list or be reached by any prompt.
    const sessionPrincipal = await verifyToken(this.#props().token, this.env.SESSION_SECRET);

    for (const def of toolsForRole(sessionPrincipal.role)) {
      this.server.tool(def.name, def.description, def.schema, async (args: any) => {
        // Re-verify on EVERY call, not once at connect. A session checked only
        // at handshake keeps its privileges after access is revoked, and an
        // agent loop is long enough to sit inside that window.
        const principal = await verifyToken(this.#props().token, this.env.SESSION_SECRET);

        const result = await withAudit(
          this.env, principal, def.name, def.accountArg, args,
          (db) => dispatch(def.name, db, this.env, args, this.#props().publicBase),
        );

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  }
}
