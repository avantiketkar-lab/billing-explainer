# Data Model, Seed Fixture, and Tenancy Leak Analysis

Companion to `docs/tool-surface.md`. Schema DDL is in `schema.sql`; the fixture
generator and its assertions are in `seed.mjs`.

---

## 1. Conventions the schema commits to

**Money is integer cents. Everywhere.** No floating-point value ever touches an
amount. Usage quantities are `REAL` because a metered quantity genuinely is one;
the moment a quantity becomes an amount it is rounded once, into cents, and never
re-derived from a float again.

**Every temporal range is `[effective_from, effective_to)`** — from inclusive, to
exclusive, `NULL` meaning open. Chosen because it composes: adjacent periods
share a boundary value with no off-by-one, and "is this discount live on date D"
is `from <= D AND (to IS NULL OR D < to)` with no special cases. Applied to
`rate_cards`, `subscriptions`, `subscription_addons`, and `discounts`.

**A schema that can only represent the present is disqualifying here.** `as_of`
is a required parameter on `get_rate_card`, and the audit record pins a data
version, so pricing and entitlement history must be reconstructible. The test
this schema is built to pass: *six months from now, can we re-derive exactly what
we told this customer in July, even though pricing has changed twice since?*
Hence `invoices.rate_card_id` — the invoice records which rate card produced it.

**Ids are ULIDs, never sequential.** Scope checks are the security control, but
sequential ids turn the denial log into an enumeration oracle: an attacker who
can distinguish "denied, exists" from "denied, does not exist" learns your
customer count and their invoice volumes.

---

## 2. `line_key` — why invoice diffing needs no heuristics

Every line carries a **stable key that survives across periods**:

```
line_key := '<product_code>:<metric|->:<kind>'

subscription:-:base
usage:api_requests_m:overage
usage:bandwidth_gb:overage
addon:ADVANCED_SECURITY:proration
discount:LAUNCH_CREDIT:discount
```

With `UNIQUE (invoice_id, line_key)`, `compare_invoices` is a **full outer join on
`line_key`** — present in both, present in A only, present in B only — and the
ranked delta falls out of the arithmetic. No description string matching, no
fuzzy alignment, no model judgment.

This is the concrete form of *compute in code, narrate in the model*. A line that
appears in July and not in June is not a guess; it is a `NULL` on one side of a
join. The expired discount and the new prorated add-on are both detected this
way, and both are the kind of thing a human scanning two PDFs misses.

Proration is explicit rather than implied: `is_prorated`, `proration_numerator`,
`proration_denominator`, and the date range. The agent can therefore say *"billed
16 of 31 days"* as a fact read from the row, not as an inference from the amount.

---

## 3. The audit log: the write path, and the honest limit

The audit table lives in the **audit Durable Object's own SQLite storage**, not in
D1. Four properties, in increasing order of how much they are worth:

1. **Only the audit DO holds the binding.** Tool handlers have no route to the
   table; they call `auditDO.append(entry)` through the DO stub.
2. **The module exports exactly `append()` and `read()`.** There is no function
   anywhere in the codebase that issues `UPDATE` or `DELETE` against `audit_log`.
3. **Engine-level triggers.** `audit_log_no_update` and `audit_log_no_delete`
   `RAISE(ABORT)`. This catches the case (1) and (2) do not: a future code path
   written by someone who never read this document.
4. **Hash chain.** `entry_hash = sha256(prev_hash || canonical_json(entry))`,
   genesis `prev_hash = "0"*64`. `verify()` walks the chain from genesis.

**The Durable Object's single-threaded execution is what makes the chain safe.**
Chain construction is a read-modify-write on the head; in a normally concurrent
store that needs a lock and a lock is a thing that can be got wrong. A DO
serialises by construction, so the correctness argument is a property of the
platform rather than of the code. This is a real reason to put the audit log
here rather than in D1.

### The limit, stated plainly

An operator with direct D1 or DO access can drop the triggers and rewrite rows.
You cannot make that impossible from inside the system, and a design document
that claims otherwise is not credible.

What the chain buys is **detectability**, not prevention: any rewrite that does
not also recompute every subsequent hash breaks verification. To close the
remaining gap the chain head must be anchored somewhere the application cannot
rewrite — hence `audit_chain_anchors`, mirroring a periodic head hash to R2 with
object-lock (specified, not built). Without an external anchor, an attacker who
owns the database can recompute the whole chain and the log proves nothing.

---

## 4. The seed fixture — engineered, not plausible

The demo question is *"why did this account's invoice go up 40% in July?"*. A
single-cause answer proves nothing a dashboard filter could not do. The fixture
is therefore built so the increase decomposes into **three overlapping causes of
clearly different magnitudes**, with the smallest being the one a human scanning
a dashboard reliably misses.

### Catalogue

| | |
|---|---|
| Plan | Business — **$600.00**/mo base |
| Included | 100M API requests · 1,000 GB bandwidth |
| Overage | **$2.00** per 1M API requests · **$0.08** per GB |
| Add-on | Advanced Security **$165.00**/mo, activated **16 Jul 2026** |
| Discount | `LAUNCH_CREDIT` flat **−$50.00**/mo, effective `[2026-02-01, 2026-07-01)` — **last billed period is June** |

### Account 1 — Northwind Analytics

| Line | May | June | July |
|---|---:|---:|---:|
| Subscription base | $600.00 | $600.00 | $600.00 |
| API requests overage | $96.00 <br><small>48M × $2</small> | $104.00 <br><small>52M × $2</small> | **$232.00** <br><small>116M × $2</small> |
| Bandwidth overage | $20.80 <br><small>260 GB</small> | $24.00 <br><small>300 GB</small> | **$32.00** <br><small>400 GB</small> |
| Advanced Security (prorated 16/31) | — | — | **$85.16** |
| `LAUNCH_CREDIT` | −$50.00 | −$50.00 | **— (expired)** |
| **Total** | **$666.80** | **$678.00** | **$949.16** |

May → June is **+1.7%**: unremarkable, which is what makes June a legitimate
baseline and July an anomaly worth explaining.

### The decomposition — verified

```
  $136.00   50.2%   Usage step change (API +64M requests, bandwidth +100 GB)
   $85.16   31.4%   Add-on activated 16 Jul, prorated 16/31 days
   $50.00   18.4%   LAUNCH_CREDIT promotional discount expired
  -------   -----
  $271.16  100.0%   TOTAL CHANGE  =  40.0% of June
```

$271.16 ÷ $678.00 = **39.994%**. The three causes sum to the delta **exactly** —
no residual, no rounding drift, because the add-on proration ($165.00 × 16 ÷ 31 =
$85.1613) is rounded once into cents at line construction and never recomputed.

`seed.mjs --verify` asserts all of the above, including that the magnitudes are
**strictly ordered**, that the daily usage series sum back to the monthly totals
used for rating, and that the line items sum to the invoice total. 24 assertions,
all passing. The demo is correct before any agent code exists.

### Daily shape

July API requests run flat at roughly June's daily rate through the 8th, then
step up ~55% from the **9th** and hold. `get_usage_series` therefore returns a
detectable step with a date on it, which is what lets the explanation say *"usage
stepped up on 9 July and stayed there"* rather than *"usage was higher"*. The
generator applies ±4% jitter and folds rounding residue into the final day so the
month total is exact.

### Account 2 — Harborlight Media (control)

Same plan, no add-on, no discount, flat usage (~$621 every month). It exists for
two reasons: it gives the internal-role demo a contrast case, and it is **the
account a customer-scoped session must be unable to see.** The tenancy test in
§5 is written against it.

---

## 5. Tenancy leak analysis

Where a customer-scoped read could return another account's data, ranked by how
likely it is to actually happen.

### 5.1 Child tables reached by parent id — the structural one

`get_invoice(invoice_id)` selects line items **by `invoice_id`**. If
`invoice_line_items` had no `account_id`, scope enforcement would depend on a
*preceding* query having checked that the invoice belongs to the caller — and
correctness would then rest on every future handler remembering to do that first.
That is the leak that eventually ships.

**Mitigation, and it is the reason for the denormalisation:** every table
reachable by a tool carries `account_id` even where it is derivable by join, so
the scope predicate goes in the **same `WHERE` clause as the selector**:

```sql
SELECT * FROM invoice_line_items
 WHERE invoice_id = ?1 AND account_id = ?2   -- never a preceding check
```

Applies to `invoice_line_items`, `subscription_addons`, `credit_proposal_evidence`.

### 5.2 Aggregates — leaks that do not look like leaks

A `GROUP BY metric` missing its account predicate returns a cross-tenant sum. It
never surfaces another account's *row*, so it survives review and it survives
eyeballing the response. **Mitigation:** no raw SQL in tool handlers. All access
goes through a `ScopedDb` built with the principal, which injects the predicate;
a handler that wants a query the builder cannot express is a design conversation,
not a `db.prepare()` call.

### 5.3 Internal columns on shared tables — leaking identity, not tenancy

`subscription_change_events.actor_id` and `actor_type` name internal staff and
systems. A customer scoped correctly to their own account still must not learn
that *"support agent j.mills applied a manual adjustment."* **Mitigation:**
per-role column projections defined once, next to the role definition, not
per query. `billing_search_billing_events` is absent from the customer manifest
entirely; the internal columns are additionally stripped at projection so a
future tool cannot re-expose them by accident.

### 5.4 Catalogue joins dragging account data along

`rate_cards` and `plans` are genuinely shared catalogue data and correctly carry
no `account_id`. `discounts` are account-specific. A `get_rate_card` handler that
joins discounts "to show the effective price" would return another account's
negotiated terms — commercially sensitive in a way an invoice line is not.
**Mitigation:** the rate-card tool returns list pricing only. Account-specific
pricing comes from a scoped tool, and the two are not joined.

### 5.5 Evidence references crossing accounts

`billing_propose_credit` accepts `evidence_refs[]` as ids. A proposal on account
A carrying an invoice id from account B would render B's data on the approval
page — a leak that arrives via the *write* path and surfaces in a human UI.
**Mitigation:** `credit_proposal_evidence.account_id` is validated to equal the
proposal's account at write time; mismatched refs are rejected, not filtered.

### 5.6 Enumeration via denial responses

Covered by ULID ids (§1), plus: denials return one undifferentiated error. "Not
found" and "not permitted" must be indistinguishable to the caller, while the
audit log records which it actually was.

### The test that has to exist

A customer-scoped session for Northwind requests a Harborlight invoice id. It
must be denied, and the denial must appear in the audit log with
`decision='denied'` and `requested_scope` recorded. That test is the tripwire: it
is what fails loudly if someone later refactors the scope predicate out of the
query builder.
