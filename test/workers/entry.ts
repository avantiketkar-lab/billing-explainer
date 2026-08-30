/**
 * Worker entry for the WORKERS TEST PROJECT ONLY.
 *
 * Why this exists: the real entry (src/index.ts) exports the MCP agent, which
 * pulls in @modelcontextprotocol/sdk -> ajv, whose CJS build does
 * `require('./refs/data.json')`. The Workers test runtime parses that JSON as
 * JavaScript and fails on the first ':'. It is a test-harness module-loading
 * problem, not a runtime one — esbuild handles it fine under `wrangler dev`.
 *
 * Rather than stub out the thing under test, the suite targets the layer that
 * actually enforces: `withAudit` in src/mcp/guard.ts. The MCP server is a thin
 * adapter over it, so nothing security-relevant is skipped here. The transport
 * itself is verified by running the app (see README, "Run it").
 */
import { DurableObject } from 'cloudflare:workers';

export { AuditLog } from '../../src/audit/audit-do';
export { BillingAgent } from '../../src/agent/agent-do';
export { DemoLimiter } from '../../src/limits/demo-limiter';
export { BillingInvestigation } from '../../src/agent/investigator-workflow';

/** Placeholder so the MCP_AGENT binding resolves; never invoked by the suite. */
export class BillingExplainerMCP extends DurableObject {
  async fetch() {
    return new Response('MCP transport is not mounted in the test entry', { status: 501 });
  }
}

export default {
  async fetch() {
    return new Response('test entry', { status: 200 });
  },
};
