# Tool Surface & Authorization Boundary

Billing Explainability MCP Server — design specification.
Written before implementation; this document is the contract the code is held to.

---

## 0. The governing principle

**The agent's write surface is its own workspace, never the ledger.**

Every read tool exists to let the agent *join across* four systems that no single dashboard joins today — subscriptions, usage metering, invoicing, and the ledger. Every write tool exists to let the agent *record what it concluded*. Nothing in the tool surface moves money, and nothing in it speaks to a customer.

That single sentence determines most of what follows.

---

## 1. Tool list

Namespace: `billing_*`. All tools are declared with strict JSON Schema; unknown properties are rejected rather than ignored.

### READ tools

| Tool | Parameters | Returns | What the model uses it for |
|---|---|---|---|
| `billing_resolve_account` | `identifier: string` (email, domain, or account id) | `account_id`, `name`, `status`, `currency`, `billing_period` | Entry point. Turns whatever the human typed into a canonical id. |
| `billing_get_account_summary` | `account_id` | plan, subscription state, current period, balance, open invoice count | One call to orient before deciding what to investigate. |
| `billing_list_invoices` | `account_id`, `from`, `to`, `limit≤24` | invoice headers: `invoice_id`, period, status, total, currency | Find the invoices in question. Headers only — deliberately not full documents. |
| `billing_get_invoice` | `invoice_id` | full document: line items with product, metric, quantity, unit price, amount, proration flag, discount refs | The primary evidence object. |
| **`billing_compare_invoices`** | `invoice_a`, `invoice_b` | per-line delta, **ranked by absolute contribution to the total change**, with `unchanged` collapsed | **The centrepiece.** See §1.1. |
| `billing_get_usage_series` | `account_id`, `metric`, `granularity: day\|week\|month`, `from`, `to` | timeseries + aggregate + prior-period comparison + detected step changes | Explains *why* a metered line moved. |
| `billing_get_subscription_history` | `account_id`, `from`, `to` | ordered change events: plan changes, add-ons, entitlement changes, effective dates, proration markers | Catches mid-period plan changes — the most common cause of a surprising invoice. |
| `billing_get_rate_card` | `plan_id \| account_id`, `as_of: date` | included allowances, overage rates, tier breakpoints, discounts in effect | Pricing changes over time. `as_of` is required, not optional. |
| `billing_list_ledger_entries` | `account_id`, `from`, `to`, `types[]` | credits, debits, payments, adjustments, refunds, each with invoice refs | Explains balance movement that the invoice alone does not. |
| `billing_get_entitlements` | `account_id`, `as_of: date` | features, quotas, limits in effect | Answers "what is this customer entitled to." |
| `billing_search_billing_events` | `account_id`, `event_types[]`, `from`, `to` | internal change log: who changed what, when, via which system | Gets from *"the number changed"* to *"because a discount expired on the 14th."* **Internal callers only.** |

### WRITE tools

| Tool | Parameters | Returns | Gating |
|---|---|---|---|
| `billing_record_case_note` | `account_id`, `body`, `evidence_refs[]` | `note_id` | Unattended. Writes to the agent's own case workspace. |
| `billing_propose_credit` | `account_id`, `amount`, `currency`, `reason`, `evidence_refs[]` | `proposal_id`, `status: PENDING`, `approval_url` | **Creates a proposal only.** Cannot move money. See §3. |
| `billing_get_proposal_status` | `proposal_id` | `PENDING \| APPROVED \| REJECTED \| EXPIRED` | Read-shaped, grouped here because it only exists to close the propose loop. |
| `billing_open_escalation` | `account_id`, `summary`, `evidence_refs[]` | `ticket_id` | Unattended. The honest exit when the agent cannot explain the delta. |

### 1.1 Why `compare_invoices` is a tool and not a model task

The model *can* subtract two numbers. It should not be the thing that does, because arithmetic over a revenue document is exactly where a fluent wrong answer is most expensive and least detectable. Moving the diff into deterministic server code means:

- the ranking of contributing causes is reproducible and testable;
- the audit record contains a computed delta, not a generated one;
- the model's job narrows to *explaining* a delta it was handed, which is what language models are actually good at.

This is the general rule the tool surface follows: **compute in code, narrate in the model.**

### 1.2 On the read/write asymmetry — agreed, with a sharpening

Eleven reads, four writes, and only one of the writes touches anything a customer would notice. That asymmetry is principled, not incidental: the *value* of this system is entirely in the join across systems, and the *risk* is entirely in mutation, so the design widens the first and narrows the second.

The sharpening, and it matters: **"read-only" is not a synonym for "safe."** The hardest authorization work in this system is on the read surface, because a customer reading another customer's invoice is a breach — a worse one than a mis-drafted case note. Reads get the same scope enforcement and the same audit treatment as writes. The write surface is where the *approval* thinking lives; the read surface is where the *scope* thinking lives.

---

## 2. The authorization boundary

### 2.1 The chain

| Hop | What happens | Where the check lives |
|---|---|---|
| **1. Human → chat surface** | Internal staff authenticate via Cloudflare Access (Zero Trust) → JWT with identity + group claims. Customers authenticate against the billing app's IdP → session. | Worker validates the JWT/session on every request. Output: a **verified principal**. |
| **2. Chat → agent session** | The agent is a Durable Object, one per session. The principal is bound **at DO construction** and is immutable for the life of the object. | The DO has no method that mutates the principal. Not "we don't call it" — it does not exist. |
| **3. Agent → MCP server** | The agent presents a short-lived, audience-scoped token carrying `principal_id`, `role`, `account_scope[]`, `session_id`, `exp`. | MCP server validates on connect **and on every `tools/call`** — not once at handshake. |
| **4. MCP server → data** | Scope is injected into every query server-side. | Row-level enforcement at the query boundary, not filtering of results after retrieval. |

### 2.2 The rule that does the actual work

> **`account_id` in tool arguments is a selector, not an authorization claim.**

If the token's `account_scope` does not contain the requested `account_id`, the call fails — and the denial is itself an audit event.

This is the specific failure mode that makes agent-accessible revenue systems dangerous. A model will cheerfully pass any `account_id` it saw anywhere in its context, including one pasted into a support ticket by an attacker. **Model output must never be able to widen scope.** Identity flows down the stack out-of-band from the conversation; it is never a tool parameter.

### 2.3 The two caller types

| | Internal support engineer | Account-scoped customer |
|---|---|---|
| **Scope** | Book of business, or all accounts by group claim | Exactly one `account_id` |
| **Reads** | All eleven tools | Invoices, usage, rate card, entitlements, subscription history — **for their own account only** |
| **Blocked reads** | — | `billing_search_billing_events` (internal actors and systems), internal-only ledger types (write-offs, bad-debt adjustments) |
| **Writes** | Case notes, escalations, credit proposals up to a cap | Escalation only |
| **Approvals** | **May not approve their own proposal** | n/a |

### 2.4 The tool list itself is scoped

`tools/list` returns a **different set per role.** A customer session never sees `billing_propose_credit` in its manifest at all.

Two reasons, and the second is the important one:

1. Token economy — a smaller manifest is a cheaper and more accurate context.
2. **Prompt-injection resistance** — a model cannot be argued into calling a tool it has never been told exists. Hiding the tool is not the security control (the scope check is), but it removes the attack from the model's reach entirely rather than relying on a refusal.

---

## 3. Write gating — the mechanism, not the intention

**`billing_apply_credit` does not exist.** There is no agent-callable path that moves money. That is the gate.

The flow:

1. Agent calls `billing_propose_credit` with an amount, a reason, and `evidence_refs[]` pointing at the specific invoice lines and usage series it relied on.
2. Server persists a proposal in `PENDING`, mints a signed `approval_url`, returns both. **No money has moved and no customer has been told anything.**
3. A human — authenticated separately, in a different surface, and never the proposing engineer — opens the URL, sees the proposal *with its evidence chain rendered*, and approves or rejects.
4. **The server applies the credit** on approval. The agent is not in this step.
5. Agent polls `billing_get_proposal_status` to close its loop and write the outcome into its case note.

### Why not a `confirmed: true` parameter, or MCP elicitation alone

Both put the gate in the same trust domain as the thing being gated. If the model can call `apply_credit(confirmed=true)`, then the only thing between a prompt injection and a refund is the model's judgment — which is not a control, it is a hope. Elicitation is a genuinely useful UX primitive and is worth using for *low-stakes* confirmations, but it asks the client, and in an agent loop the client is not reliably a human paying attention.

The two-phase design is stronger because of what it makes impossible rather than what it discourages: **the credential required to approve is one the model never holds.** Out-of-band approval is the control; everything else is ergonomics.

Caps as defence in depth: proposals above a threshold require a second approver, and per-session proposal count is rate-limited. A model stuck in a loop should hit a wall, not a spreadsheet.

---

## 4. The audit record

One append-only entry per tool call, written **before the response is returned** so a crash mid-call still leaves the attempt on the record.

```jsonc
{
  "call_id":        "uuid",
  "prev_hash":      "sha256 of the previous entry",   // hash chain
  "ts":             "2026-08-28T17:42:03.117Z",
  "session_id":     "...",
  "parent_call_id": "...",            // multi-step chains reconstruct

  "principal_id":   "...",
  "principal_role": "support_engineer | customer",
  "token_jti":      "...",

  "tool_name":      "billing_get_invoice",
  "arguments":      { /* redacted */ },
  "arguments_hash": "sha256",

  "requested_scope": "acct_1234",
  "resolved_scope":  "acct_1234",     // what was ENFORCED, not what was asked
  "decision":        "allowed | denied",
  "denial_reason":   null,

  "source_system":   "invoicing-api",
  "as_of":           "2026-08-01T00:00:00Z",   // version pin — see below
  "result_hash":     "sha256 of payload",      // hash, not payload: PII stays out
  "latency_ms":      41,

  "model_id":        "@cf/meta/llama-3.3-70b-instruct",
  "assistant_turn_id": "..."
}
```

Storage: append-only in a Durable Object, mirrored to R2 for retention.

### What makes it trustworthy after the fact

- **The storage interface exposes only `append` and `read`.** No update path, no delete path — not as policy, as API surface.
- **Hash chaining.** Each entry carries the hash of its predecessor, so a removed or edited entry breaks the chain and the break is detectable by anyone with the log. Cheap to implement; it is the difference between a log and an audit trail.
- **As-of pinning.** Every entry records the source system and the data version/timestamp it read. Without this, *"why did we tell this customer X in July"* is unanswerable once the underlying data moves. With it, any past explanation can be re-derived and checked.
- **Result hashes, not result payloads.** The log proves what was returned without becoming a second copy of customer data with a longer retention period than the first.
- **Denials are first-class.** A denied call is logged with the same weight as a successful one. In practice the denial records are the most interesting file in the system: they are where you see a model reaching for scope it does not have.

---

## 5. Negative space — three things that could be tools and must not be

### 5.1 `billing_query` — a generic SQL or free-text query tool

The most tempting tool in any data-adjacent agent build. It makes the model instantly capable of everything and saves the entire effort of designing a tool surface.

It is disqualifying, because **the tool surface *is* the security boundary, and a generic query tool deletes it.** You cannot express "this customer may read only their own rows" against an arbitrary SQL string without writing a parser and a policy engine — at which point you have built a worse version of the typed tool surface you skipped. It also makes every audit record uninterpretable (a query string is not an intent), and it sets the blast radius of a single prompt injection to *the entire database*.

### 5.2 `billing_apply_credit` / `billing_issue_refund` — anything that moves money

Not because gating is technically impossible, but because an in-band gate is not a gate (§3). Money movement lives out-of-band by construction: the agent proposes, a human approves in a separately authenticated surface, the server applies.

There is a second reason worth stating plainly: an agent that can issue refunds has to be defended against every future prompt-injection technique, forever. An agent that can only *propose* refunds is defended by its architecture and stays defended when the attacks improve.

### 5.3 `billing_send_customer_email` / `post_to_portal` — publishing the explanation

This looks like the natural finish and it is where an explainability agent does real damage. **A fluent, wrong billing explanation sent under the company's name is a commitment** — reputationally, and depending on what it says about entitlements, contractually. It is also unretractable in a way an internal note is not.

The agent drafts. A human sends. Same reasoning as §5.2, applied to words instead of money — and words are the thing this system is actually good at producing, which is exactly why the guardrail belongs here.

**Honourable mention:** `get_payment_instrument`. Card and bank details have no role in explaining a bill. Keeping them out of the tool surface entirely means they can never enter a model context, an audit payload, or a log mirror — a compliance boundary that costs nothing to hold because nothing needs it.

---

## 6. Two-day build subset

### Build (7 tools)

`billing_resolve_account` · `billing_get_invoice` · **`billing_compare_invoices`** · `billing_get_usage_series` · `billing_get_subscription_history` · `billing_get_rate_card` · `billing_propose_credit`

Plus the parts that are the actual point:

- the full identity chain across all four hops, with both roles real;
- role-scoped `tools/list`;
- hash-chained append-only audit log in a Durable Object;
- one Workflow orchestrating the multi-step investigation;
- the approval surface as a **working stub** — a real signed URL and a real approve/reject that the server acts on, even if the page is unstyled.

**Why this subset:** it is the smallest set that answers the demo question end to end *and* exercises both sides of the authorization boundary. A read-only demo would be easier and would prove nothing about the hard part. One write tool, properly gated, is worth more than five more reads.

### Specify and document, do not build

`billing_list_invoices` · `billing_get_account_summary` · `billing_list_ledger_entries` · `billing_get_entitlements` · `billing_search_billing_events` · R2 audit mirroring and retention · real IdP integration (dev tokens carrying the identical claim shape stand in) · second-approver caps.

The README states this split explicitly. Scope discipline shown deliberately reads as judgment; the same gaps left unmentioned read as an unfinished project.

---

## 7. Seed data requirement

The demo question — *"why did this account's invoice go up 40% in July?"* — must have a **layered** answer, not an obvious one. Seed two accounts and three months such that the July increase decomposes into three overlapping causes of different sizes:

1. a genuine usage step change on one metric (largest contributor);
2. a mid-period plan change producing a prorated line (middle);
3. a promotional discount that expired (smallest, and the one a human scanning a dashboard misses).

This is the whole demo. A single-cause answer proves nothing that a dashboard filter could not do; a correctly **ranked** three-cause answer with evidence links is precisely the work a human does slowly and badly today.
