#!/usr/bin/env node
/**
 * Seed generator for the Billing Explainability MCP server.
 *
 * Emits SQL to stdout;  --verify  runs the assertions instead.
 *
 * The July invoice for acct_01 is ENGINEERED, not plausible. It must be up
 * ~40% on June and that increase must decompose into exactly three causes of
 * clearly different magnitudes. Those numbers are asserted below, so the demo
 * is verified correct before any agent code exists.
 */

const CENTS = (n) => Math.round(n);

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------
const PLAN = { id: 'plan_business', code: 'BUSINESS', name: 'Business' };
const RATE_CARD = {
  id: 'rc_business_2026',
  base_cents: 60000,                       // $600.00 / month
  effective_from: '2026-01-01',
  items: [
    { metric: 'api_requests_m', included: 100,   unit_cents: 200 },  // $2.00 per 1M
    { metric: 'bandwidth_gb',   included: 1000,  unit_cents: 8   },  // $0.08 per GB
  ],
};
const ADDON = {
  id: 'addon_advsec_01',
  code: 'ADVANCED_SECURITY',
  monthly_cents: 16500,                    // $165.00 / month
  effective_from: '2026-07-16',            // mid-period -> proration
};
const DISCOUNT = {
  id: 'disc_launch_01',
  code: 'LAUNCH_CREDIT',
  kind: 'flat_cents',
  value: 5000,                             // $50.00 / month
  effective_from: '2026-02-01',
  effective_to: '2026-07-01',              // EXCLUSIVE -> last billed period is June
};

// ---------------------------------------------------------------------------
// Monthly usage totals
// ---------------------------------------------------------------------------
const PERIODS = [
  { key: '2026-05', start: '2026-05-01', end: '2026-05-31', days: 31 },
  { key: '2026-06', start: '2026-06-01', end: '2026-06-30', days: 30 },
  { key: '2026-07', start: '2026-07-01', end: '2026-07-31', days: 31 },
];

const ACCOUNTS = [
  {
    id: 'acct_01H8NORTHWIND',
    name: 'Northwind Analytics',
    usage: {                                // the account the demo asks about
      '2026-05': { api_requests_m: 148, bandwidth_gb: 1260 },
      '2026-06': { api_requests_m: 152, bandwidth_gb: 1300 },
      '2026-07': { api_requests_m: 216, bandwidth_gb: 1400 },   // step change
    },
    hasAddon: true,
    hasDiscount: true,
    // July step: flat through the 8th, then a sustained jump from the 9th.
    stepChange: { metric: 'api_requests_m', period: '2026-07', fromDay: 9 },
  },
  {
    id: 'acct_02H8HARBORLIGHT',
    name: 'Harborlight Media',
    usage: {                                // control account — boring on purpose
      '2026-05': { api_requests_m: 110, bandwidth_gb: 1020 },
      '2026-06': { api_requests_m: 112, bandwidth_gb: 1035 },
      '2026-07': { api_requests_m: 109, bandwidth_gb: 1028 },
    },
    hasAddon: false,
    hasDiscount: false,
    stepChange: null,
  },
];

// ---------------------------------------------------------------------------
// Invoice computation — the same arithmetic the real rater would do
// ---------------------------------------------------------------------------
function computeInvoice(account, period) {
  const usage = account.usage[period.key];
  const lines = [];

  lines.push({
    line_key: 'subscription:-:base',
    kind: 'base',
    product_code: 'subscription',
    metric: null,
    amount_cents: RATE_CARD.base_cents,
    source_ref: RATE_CARD.id,
  });

  for (const item of RATE_CARD.items) {
    const qty = usage[item.metric];
    const billable = Math.max(0, qty - item.included);
    if (billable <= 0) continue;
    lines.push({
      line_key: `usage:${item.metric}:overage`,
      kind: 'overage',
      product_code: 'usage',
      metric: item.metric,
      quantity: qty,
      included_qty: item.included,
      billable_qty: billable,
      unit_price_cents: item.unit_cents,
      amount_cents: CENTS(billable * item.unit_cents),
      source_ref: RATE_CARD.id,
    });
  }

  // Mid-period add-on -> prorated line
  if (account.hasAddon && ADDON.effective_from >= period.start && ADDON.effective_from <= period.end) {
    const startDay = Number(ADDON.effective_from.slice(8, 10));
    const billedDays = period.days - startDay + 1;
    lines.push({
      line_key: `addon:${ADDON.code}:proration`,
      kind: 'proration',
      product_code: 'addon',
      metric: null,
      amount_cents: CENTS((ADDON.monthly_cents * billedDays) / period.days),
      is_prorated: 1,
      proration_numerator: billedDays,
      proration_denominator: period.days,
      proration_from: ADDON.effective_from,
      proration_to: period.end,
      source_ref: ADDON.id,
    });
  }

  // Discount, if in effect for this period ([from, to) — `to` is exclusive)
  let discount_cents = 0;
  if (account.hasDiscount &&
      period.start >= DISCOUNT.effective_from &&
      period.start < DISCOUNT.effective_to) {
    discount_cents = -DISCOUNT.value;
    lines.push({
      line_key: `discount:${DISCOUNT.code}:discount`,
      kind: 'discount',
      product_code: 'discount',
      metric: null,
      amount_cents: discount_cents,
      source_ref: DISCOUNT.id,
    });
  }

  const subtotal = lines.filter(l => l.kind !== 'discount')
                        .reduce((a, l) => a + l.amount_cents, 0);
  const total = subtotal + discount_cents;
  return { lines, subtotal_cents: subtotal, discount_cents, total_cents: total };
}

// ---------------------------------------------------------------------------
// Daily usage distribution — jitter, then force the month total to be exact
// ---------------------------------------------------------------------------
let rngState = 42;
function rand() { rngState = (rngState * 1103515245 + 12345) & 0x7fffffff; return rngState / 0x7fffffff; }

function dailySeries(account, period, metric) {
  const total = account.usage[period.key][metric];
  const step = account.stepChange;
  const isStep = step && step.metric === metric && step.period === period.key;

  const weights = [];
  for (let d = 1; d <= period.days; d++) {
    let w = 1;
    if (isStep && d >= step.fromDay) w = 1.55;         // sustained jump
    w *= 0.96 + rand() * 0.08;                          // +/- ~4% jitter
    weights.push(w);
  }
  const wsum = weights.reduce((a, b) => a + b, 0);
  const vals = weights.map(w => (w / wsum) * total);
  // Force exactness: fold all rounding residue into the final day.
  const rounded = vals.map(v => Math.round(v * 1000) / 1000);
  const drift = total - rounded.reduce((a, b) => a + b, 0);
  rounded[rounded.length - 1] = Math.round((rounded[rounded.length - 1] + drift) * 1000) / 1000;
  return rounded;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------
function verify() {
  const a1 = ACCOUNTS[0];
  const jun = computeInvoice(a1, PERIODS[1]);
  const jul = computeInvoice(a1, PERIODS[2]);
  const may = computeInvoice(a1, PERIODS[0]);

  const get = (inv, key) => (inv.lines.find(l => l.line_key === key)?.amount_cents ?? 0);

  const causeUsage =
      (get(jul, 'usage:api_requests_m:overage') - get(jun, 'usage:api_requests_m:overage')) +
      (get(jul, 'usage:bandwidth_gb:overage')   - get(jun, 'usage:bandwidth_gb:overage'));
  const causeProration =
      get(jul, `addon:${ADDON.code}:proration`) - get(jun, `addon:${ADDON.code}:proration`);
  const causeDiscount =
      get(jul, `discount:${DISCOUNT.code}:discount`) - get(jun, `discount:${DISCOUNT.code}:discount`);

  const delta = jul.total_cents - jun.total_cents;
  const pct = (delta / jun.total_cents) * 100;

  const fmt = (c) => `$${(c / 100).toFixed(2)}`;
  const checks = [];
  const check = (name, cond, detail) => checks.push({ name, ok: !!cond, detail });

  check('May total    = $666.80', may.total_cents === 66680, fmt(may.total_cents));
  check('June total   = $678.00', jun.total_cents === 67800, fmt(jun.total_cents));
  check('July total   = $949.16', jul.total_cents === 94916, fmt(jul.total_cents));
  check('Delta        = $271.16', delta === 27116, fmt(delta));
  check('Increase is ~40%', Math.abs(pct - 40) < 0.05, `${pct.toFixed(3)}%`);
  check('Cause 1 usage      = $136.00', causeUsage === 13600, fmt(causeUsage));
  check('Cause 2 proration  = $85.16',  causeProration === 8516, fmt(causeProration));
  check('Cause 3 discount   = $50.00',  causeDiscount === 5000, fmt(causeDiscount));
  check('Three causes sum EXACTLY to the delta',
        causeUsage + causeProration + causeDiscount === delta,
        `${fmt(causeUsage + causeProration + causeDiscount)} vs ${fmt(delta)}`);
  check('Magnitudes are strictly ordered (usage > proration > discount)',
        causeUsage > causeProration && causeProration > causeDiscount,
        `${fmt(causeUsage)} > ${fmt(causeProration)} > ${fmt(causeDiscount)}`);
  check('May->June is unremarkable (<5%)',
        Math.abs((jun.total_cents - may.total_cents) / may.total_cents) < 0.05,
        `${(((jun.total_cents - may.total_cents) / may.total_cents) * 100).toFixed(2)}%`);
  check('No rounding drift: lines sum to invoice total',
        jul.lines.reduce((a, l) => a + l.amount_cents, 0) === jul.total_cents,
        fmt(jul.lines.reduce((a, l) => a + l.amount_cents, 0)));

  // Daily series must sum back to the monthly totals used for rating.
  for (const acct of ACCOUNTS) {
    for (const p of PERIODS) {
      for (const m of ['api_requests_m', 'bandwidth_gb']) {
        const s = dailySeries(acct, p, m);
        const sum = Math.round(s.reduce((a, b) => a + b, 0) * 1000) / 1000;
        check(`daily ${acct.id.slice(0, 7)} ${p.key} ${m} sums to month`,
              Math.abs(sum - acct.usage[p.key][m]) < 0.001,
              `${sum} vs ${acct.usage[p.key][m]}`);
      }
    }
  }

  const pad = Math.max(...checks.map(c => c.name.length));
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(pad)}  ${c.detail}`);
  }
  const failed = checks.filter(c => !c.ok).length;

  console.log('\n--- July decomposition -------------------------------------');
  const rows = [
    ['Usage step change (API +64M req, bandwidth +100GB)', causeUsage],
    ['Add-on activated 16 Jul, prorated 16/31 days',   causeProration],
    ['LAUNCH_CREDIT promotional discount expired',      causeDiscount],
  ].sort((a, b) => b[1] - a[1]);
  for (const [label, cents] of rows) {
    console.log(`  ${fmt(cents).padStart(8)}  ${((cents / delta) * 100).toFixed(1).padStart(5)}%  ${label}`);
  }
  console.log(`  ${fmt(delta).padStart(8)}  100.0%  TOTAL CHANGE (${pct.toFixed(1)}% of June)`);

  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// SQL emission
// ---------------------------------------------------------------------------
const q = (v) =>
  v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
const row = (table, obj) =>
  `INSERT OR REPLACE INTO ${table} (${Object.keys(obj).join(', ')}) VALUES (${Object.values(obj).map(q).join(', ')});`;

/** Deterministic opaque ids — readable prefix, unguessable-looking body. */
let idc = 0;
const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function oid(prefix) {
  idc += 1;
  let n = idc * 2654435761 + 0x9e3779b9, out = '';
  for (let i = 0; i < 16; i++) { out += CROCK[n % 32]; n = Math.floor(n / 32) + (i * 7919); }
  return `${prefix}_${out}`;
}

function emit() {
  // No BEGIN TRANSACTION / COMMIT: remote D1 rejects explicit SQL transactions
  // ("use state.storage.transaction() instead"). Local --file tolerates them,
  // so this only shows up the first time you seed a remote database.
  const out = [];
  const now = '2026-08-01T00:00:00Z';

  out.push(row('plans', { plan_id: PLAN.id, code: PLAN.code, name: PLAN.name }));
  out.push(row('rate_cards', {
    rate_card_id: RATE_CARD.id, plan_id: PLAN.id, base_cents: RATE_CARD.base_cents,
    effective_from: RATE_CARD.effective_from, effective_to: null,
  }));
  for (const it of RATE_CARD.items) {
    out.push(row('rate_card_items', {
      rate_card_item_id: oid('rci'), rate_card_id: RATE_CARD.id, metric: it.metric,
      included_qty: it.included, overage_unit_cents: it.unit_cents,
    }));
  }

  for (const acct of ACCOUNTS) {
    out.push(row('accounts', {
      account_id: acct.id, name: acct.name, status: 'active', currency: 'USD',
      billing_anchor: 1, created_at: '2026-01-15T00:00:00Z',
    }));

    const subId = oid('sub');
    out.push(row('subscriptions', {
      subscription_id: subId, account_id: acct.id, plan_id: PLAN.id,
      effective_from: '2026-01-15', effective_to: null,
    }));

    if (acct.hasDiscount) {
      out.push(row('discounts', {
        discount_id: DISCOUNT.id, account_id: acct.id, code: DISCOUNT.code,
        kind: DISCOUNT.kind, value: DISCOUNT.value,
        effective_from: DISCOUNT.effective_from, effective_to: DISCOUNT.effective_to,
      }));
      // The expiry is a first-class EVENT, not an absence. This is the row that
      // lets the agent name the smallest cause instead of missing it.
      out.push(row('subscription_change_events', {
        event_id: oid('evt'), account_id: acct.id,
        occurred_at: '2026-07-01T00:00:00Z', effective_at: '2026-07-01',
        change_type: 'discount_expired', from_value: DISCOUNT.code, to_value: null,
        proration_applied: 0, actor_type: 'system', actor_id: 'billing-scheduler',
        source_system: 'billing-core',
      }));
    }

    if (acct.hasAddon) {
      out.push(row('subscription_addons', {
        addon_id: ADDON.id, account_id: acct.id, subscription_id: subId,
        addon_code: ADDON.code, monthly_cents: ADDON.monthly_cents,
        effective_from: ADDON.effective_from, effective_to: null,
      }));
      out.push(row('subscription_change_events', {
        event_id: oid('evt'), account_id: acct.id,
        occurred_at: '2026-07-16T14:22:00Z', effective_at: ADDON.effective_from,
        change_type: 'addon_added', from_value: null, to_value: ADDON.code,
        proration_applied: 1, actor_type: 'customer', actor_id: 'user_nw_admin',
        source_system: 'self-serve-portal',
      }));
    }

    // Daily usage
    for (const p of PERIODS) {
      for (const metric of ['api_requests_m', 'bandwidth_gb']) {
        const series = dailySeries(acct, p, metric);
        series.forEach((qty, i) => {
          const d = String(i + 1).padStart(2, '0');
          out.push(row('usage_records', {
            usage_id: oid('use'), account_id: acct.id, metric,
            usage_date: `${p.key}-${d}`, quantity: qty,
            source_system: 'metering-pipeline', ingested_at: now,
          }));
        });
      }
    }

    // Invoices + line items
    for (const p of PERIODS) {
      const inv = computeInvoice(acct, p);
      const invoiceId = oid('inv');
      out.push(row('invoices', {
        invoice_id: invoiceId, account_id: acct.id,
        period_start: p.start, period_end: p.end, status: 'issued', currency: 'USD',
        subtotal_cents: inv.subtotal_cents, discount_cents: inv.discount_cents,
        total_cents: inv.total_cents,
        issued_at: `${p.end}T23:59:00Z`, rate_card_id: RATE_CARD.id,
      }));
      for (const l of inv.lines) {
        out.push(row('invoice_line_items', {
          line_id: oid('lin'), invoice_id: invoiceId, account_id: acct.id,
          line_key: l.line_key, kind: l.kind, product_code: l.product_code,
          metric: l.metric ?? null, quantity: l.quantity ?? null,
          included_qty: l.included_qty ?? null, billable_qty: l.billable_qty ?? null,
          unit_price_cents: l.unit_price_cents ?? null, amount_cents: l.amount_cents,
          is_prorated: l.is_prorated ?? 0,
          proration_numerator: l.proration_numerator ?? null,
          proration_denominator: l.proration_denominator ?? null,
          proration_from: l.proration_from ?? null, proration_to: l.proration_to ?? null,
          source_ref: l.source_ref ?? null,
        }));
      }
    }
  }

  return out.join('\n');
}

if (process.argv.includes('--verify')) verify();
else if (process.argv.includes('--emit')) console.log(emit());
else console.log(emit());
