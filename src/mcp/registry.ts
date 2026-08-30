import { z } from 'zod';
import type { Role } from '../types';

/**
 * The tool registry, with per-role visibility.
 *
 * `tools/list` returns a DIFFERENT SET per role. A customer session never sees
 * propose_credit in its manifest at all.
 *
 * Hiding the tool is not the security control — the scope check in ScopedDb is.
 * But removing a tool from the manifest removes it from the model's reach
 * entirely, so an injected instruction cannot argue the model into calling
 * something it has never been told exists. Defence in depth, plus a smaller and
 * therefore more accurate context.
 */
export interface ToolDef {
  name: string;
  title: string;
  description: string;
  access: 'read' | 'write';
  roles: readonly Role[];
  schema: z.ZodRawShape;
  /** Which argument, if any, names the account being selected. */
  accountArg?: string;
}

const ALL: readonly Role[] = ['support_engineer', 'customer'];
const INTERNAL: readonly Role[] = ['support_engineer'];

export const TOOLS: readonly ToolDef[] = [
  {
    name: 'billing_resolve_account',
    title: 'Resolve account',
    description: 'Turn an email, domain, or account id into a canonical account record.',
    access: 'read', roles: ALL,
    schema: { identifier: z.string().min(1) },
  },
  {
    name: 'billing_get_invoice',
    title: 'Get invoice',
    description: 'Fetch one invoice with its full line items.',
    access: 'read', roles: ALL,
    schema: { invoice_id: z.string().min(1) },
  },
  {
    name: 'billing_find_invoice',
    title: 'Find invoice by period',
    description: 'Find the invoice covering a billing period, given the period start date.',
    access: 'read', roles: ALL,
    accountArg: 'account_id',
    schema: {
      account_id: z.string().min(1),
      period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    },
  },
  {
    name: 'billing_compare_invoices',
    title: 'Compare invoices',
    description:
      'Diff two invoices line by line and return the change ranked by absolute contribution. ' +
      'Use this instead of subtracting amounts yourself.',
    access: 'read', roles: ALL,
    schema: { invoice_a: z.string().min(1), invoice_b: z.string().min(1) },
  },
  {
    name: 'billing_get_usage_series',
    title: 'Get usage series',
    description: 'Daily metered usage for one metric, with aggregates and detected step changes.',
    access: 'read', roles: ALL,
    accountArg: 'account_id',
    schema: {
      account_id: z.string().min(1),
      metric: z.enum(['api_requests_m', 'bandwidth_gb']),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    },
  },
  {
    name: 'billing_get_subscription_history',
    title: 'Get subscription history',
    description: 'Plan changes, add-ons and discount events in effect over a date range.',
    access: 'read', roles: ALL,
    accountArg: 'account_id',
    schema: {
      account_id: z.string().min(1),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    },
  },
  {
    name: 'billing_get_rate_card',
    title: 'Get rate card',
    description: 'List pricing in effect on a given date: base, included allowances, overage rates.',
    access: 'read', roles: ALL,
    accountArg: 'account_id',
    schema: {
      account_id: z.string().min(1),
      as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    },
  },
  {
    name: 'billing_propose_credit',
    title: 'Propose a credit',
    description:
      'Create a PENDING credit proposal for human approval. This does NOT apply a credit and ' +
      'does not move money. Returns an approval URL for a human to act on.',
    access: 'write',
    roles: INTERNAL,          // <- absent from a customer manifest entirely
    accountArg: 'account_id',
    schema: {
      account_id: z.string().min(1),
      amount_cents: z.number().int().positive(),
      reason: z.string().min(10),
      evidence_refs: z.array(z.object({
        ref_type: z.enum(['invoice', 'line', 'usage_series', 'change_event']),
        ref_id: z.string().min(1),
      })).min(1),
    },
  },
] as const;

export const toolsForRole = (role: Role) => TOOLS.filter((t) => t.roles.includes(role));
