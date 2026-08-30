# Why it's built this way

The assignment asked for an AI application. The easy read is a chat wrapper over
a billing database. That demonstrates one thing — that you can call a model —
and skips the question a billing platform actually faces next:

> **What is an agent allowed to read versus change, and how is that audited?**

So the deliverable is an MCP server with a real authorization model, and the
decisions below are the argument. Each one names what it rules out, because a
design decision that forbids nothing isn't a decision.

---

## 1. Scope cannot be forgotten

**`src/db/scoped-db.ts`**

The rule: **`account_id` in a tool argument is a *selector*, not an
authorization claim.** A model will cheerfully pass any account id it saw
anywhere in its context — including one an attacker pasted into a support
ticket. So scope travels out-of-band, in a signed token bound to the session at
construction, and model output can never widen it.

Enforcing that by convention fails eventually. So it's enforced by shape:

- The D1 binding lives in a **`#private` field** — an ECMAScript private, not a
  TypeScript `private`. The latter is erased at compile time and defeated by
  `(db as any).db`; the former is unreachable at runtime.
- `ScopedDb` exposes **named repository methods, not a query interface**. There
  is no `prepare`, `exec` or `batch` to reach for.
- The scope predicate sits in the **same `WHERE` clause as the selector**, never
  in a preceding check that a future handler might forget:
  ```sql
  SELECT * FROM invoice_line_items WHERE invoice_id = ?1 AND account_id = ?2
  ```
  This is why `account_id` is denormalised onto every tool-reachable child
  table even where a join would derive it.
- `env.DB` appears in **exactly one module**, and a test asserts it by scanning
  the source tree. Routing around the class fails CI, not review.

**Ruled out:** a generic `query` / SQL tool. It's the most tempting tool in any
data-adjacent agent build and it's disqualifying — you cannot express "this
customer may read only their own rows" against an arbitrary SQL string without
writing a parser and a policy engine, at which point you've built a worse
version of the typed surface you skipped. It also makes every audit record
uninterpretable and sets the blast radius of one prompt injection to the whole
database.

---

## 2. The agent's write surface is its own workspace, never the ledger

**`src/mcp/registry.ts`, `src/mcp/tools/index.ts`**

Twelve read tools, four writes, and none of the writes move money or speak to a
customer. The asymmetry is principled: the **value** is in the join across four
systems, the **risk** is entirely in mutation. Widen the first, narrow the
second.

`billing_apply_credit` **does not exist.** Not gated — absent. The agent calls
`propose_credit`, which creates a `PENDING` proposal with evidence references
and returns a signed approval URL. A human — never the proposing principal,
enforced by a `CHECK` constraint — approves in a separately authenticated
surface, and **the server** applies it.

**Why not a `confirmed: true` parameter, or MCP elicitation?** Both put the gate
in the same trust domain as the thing being gated. If the model can call
`apply_credit(confirmed=true)`, the only thing between a prompt injection and a
refund is the model's judgement — which is a hope, not a control. The two-phase
design is stronger because of what it makes *impossible*: **the credential
required to approve is one the model never holds.**

The same reasoning applies to words. There is no `send_customer_email` tool. A
fluent, wrong billing explanation sent under the company's name is a commitment
— reputationally and, depending on what it says about entitlements,
contractually — and unretractable in a way an internal note is not. The agent
drafts; a human sends.

**One more sharpening:** *"read-only" is not a synonym for "safe."* The hardest
authorization work here is on the read surface, because a customer reading
another customer's invoice is a worse failure than a mis-drafted note. Six
ranked tenancy-leak vectors are in [data-model.md §5](data-model.md).

---

## 3. Compute in code, narrate in the model

**`src/mcp/tools/compare-invoices.ts`, `src/agent/compose.ts`**

The model *can* subtract two numbers. It should not be the thing that does.
Arithmetic over a revenue document is exactly where a fluent wrong answer is
most expensive and least detectable.

So invoice diffing is a **full outer join on a stable `line_key`**, with
`UNIQUE (invoice_id, line_key)` making the join exact. An expired discount is
therefore a `NULL` on one side of a join — a **fact** — rather than an inference
from a total that moved. The model receives a delta that's already computed and
ranked, and its job narrows to explaining it.

Then the prompt forbids arithmetic, forbids naming a cause outside the ranked
list, and requires a citation per claim. **But prompt rules are a request, so
there is also a check.** `validateExplanation()` verifies the output actually
complied:

- every citation resolves to a real `line_key`, usage date, or event id;
- every money figure appears **verbatim** in the evidence;
- an unreconciled comparison is disclosed in the opening sentence;
- no commitment is made.

**On failure the narration is withheld** and the computed ranking is shown
instead. A deterministic, ugly, correct answer beats a fluent one that cited
something that does not exist. Verified against five adversarial cases —
hallucinated citation, invented figure, commitment, undisclosed
non-reconciliation, and empty output (which would otherwise pass every check
vacuously).

The same property covers the model being unavailable entirely: the system still
answers, with the computed evidence, and says why. **The arithmetic is the
product; the prose is a layer over it.**

---

## 4. An audit trail, not a log

**`src/audit/audit-do.ts`**

One append-only entry per tool call, written **before the response is returned**
— so a crash mid-call still leaves the attempt on the record, and if a call
cannot be audited it is not disclosed.

Four properties, in increasing order of what they're worth:

1. Only the audit Durable Object holds the binding.
2. The module exports **exactly `append()` and `read()`**. No update path, no
   delete path — not as policy, as API surface.
3. **Engine-level triggers** abort `UPDATE` and `DELETE`, catching the case (1)
   and (2) don't: a future code path written by someone who never read this.
4. **Hash chain** — each entry carries the hash of its predecessor.

The Durable Object's **single-threaded execution is what makes the chain safe**.
Chain construction is a read-modify-write on the head; in a normally concurrent
store that needs a lock, and a lock is a thing that can be got wrong. A DO
serialises by construction, so the correctness argument is a property of the
platform rather than of this code. That is a real reason to put the log here
rather than in D1.

Also recorded: `resolved_scope` (what was **enforced**, not what was asked),
`as_of` (a data version pin, so a past explanation can be re-derived after
pricing moves), and a **hash of the result rather than the payload** — so the log
proves what was returned without becoming a second copy of customer data with a
longer retention period than the first. **Denials are first-class**, and in
practice they're the most interesting records in the file: they're where you see
a model reaching for scope it does not have.

### The honest limit

An operator with direct storage access can drop the triggers and rewrite rows.
You cannot make that impossible from inside the system, and a design document
claiming otherwise isn't credible. The chain buys **detectability**, not
prevention: any rewrite that doesn't also recompute every subsequent hash breaks
`verify()`. To close the rest, the head must be anchored somewhere this
application cannot rewrite — R2 with object-lock. **Specified, not built.**

---

## 5. The agent's authority is the caller's authority

**`src/agent/mcp-client.ts`, `src/agent/investigator-workflow.ts`**

The agent connects to its own MCP server with the **session's own token** — the
one the human authenticated with. No service credential, no elevated agent
identity, so there is no account the agent can reach that the person who asked
cannot. An agent holding broader credentials than its caller is the standard way
this class of system becomes a confused deputy.

The investigation runs as a **Workflow** — resolve, locate invoices, compare,
gather evidence per material cause, compose — because each step is an external
call that can fail independently and steps are durable and individually
retryable. A failure at "gather evidence" resumes there rather than re-running
the comparison and re-billing the model for tokens already spent.

**A denial is an outcome, not a crash, and it must be returned as a value.**
Workflows retries a failed step by default, so a scope violation would sit in
`running` for minutes re-deciding a refusal that will never change — writing a
fresh audit denial on every attempt. And a `NonRetryableError` thrown inside a
step is fatal *at the step boundary*: it never reaches a `try/catch` around
`run()`, so the user sees "a step threw an error", which reads as a fault in the
system rather than the access control working exactly as designed. So the
resolve step returns `{ ok: false, reason }` and the workflow answers plainly.

---

## The tool list itself is scoped

`tools/list` returns a **different set per role**. A customer session never sees
`propose_credit` in its manifest at all.

Hiding a tool is not the security control — the scope check is. But removing it
from the manifest removes it from the model's reach entirely, so an injected
instruction cannot argue the model into calling something it has never been told
exists. Defence in depth, plus a smaller and therefore more accurate context.

---

## What I'd do next

Three things, each with the reason it's next rather than a wish list.

**1. Anchor the audit chain externally.** Everything else in the audit design is
sound and this is the one gap that makes the rest merely *probably* true. A
daily head hash to R2 with object-lock is a small job that converts
"tamper-evident to anyone who trusts this database" into "tamper-evident to
anyone."

**2. Replace dev tokens with Cloudflare Access and the customer IdP.** The claim
shape is already identical, so this is configuration — but until it's real, the
authorization story is demonstrated rather than deployed, and that's the
difference a security reviewer will ask about first.

**3. Put the approval surface behind a real identity and give it the evidence
view.** The two-phase credit flow is the strongest thing in the design and its
human half is currently a stub. An approver who cannot see the evidence chain
will approve on the agent's word, which quietly re-creates the problem the
design exists to prevent.

### Known limits

- **Identity is simulated in the demo.** The role selector issues a signed
  token for whatever role is asked for — there is no authentication. Scope
  enforcement, audit and refusal are all real; only the issuing of identity is
  a stub. This is the single most important thing to know before reading the
  authorization claims as production-ready.
- Five specified read tools are designed and not implemented
  (`list_invoices`, `get_account_summary`, `list_ledger_entries`,
  `get_entitlements`, `search_billing_events`).
- The MCP transport is covered by the guard tests plus manual verification
  rather than an in-process transport test — the MCP SDK's CJS dependencies
  don't load in the Workers test runtime. The enforcement path is tested
  directly instead, and the server is a thin adapter over it.
- Workers AI has no local emulator, so `wrangler dev` needs `wrangler login`
  and the AI binding runs remotely while everything else stays local.
- The fixture is two accounts and three months. It's engineered to make the
  demo question have a layered answer, not to exercise scale.
