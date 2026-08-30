# Deploying it

The demo at the top of the [README](../README.md) is a Worker on Cloudflare's free
tier. This is how it got there, and how you would put your own copy up.

Two things are worth knowing before you start, because they shape every step
below:

- **Workers AI has no local emulator.** The narration step always runs against a
  real Cloudflare account, even during local development.
- **Local D1 and remote D1 are not the same database.** Local D1 is miniflare's
  emulator and is the more permissive of the two. Every schema and seed step has
  to be exercised against `--remote` before you trust it. (This cost me a
  deployment attempt — see incident 7 in the prompt history.)

---

## 0. Prerequisites

- **Node 20+**
- **A Cloudflare account.** Free tier is enough for everything here.
- **A workers.dev subdomain on that account.** Dashboard → **Workers & Pages →
  Account details → Subdomain**. Remote bindings cannot be established without
  one, and the error you get if it is missing names the binding rather than the
  subdomain.

```bash
npm install
npx wrangler login
```

---

## 1. Create the database

```bash
npx wrangler d1 create billing
```

This prints a `database_id`. Put it in `wrangler.jsonc`:

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "billing", "database_id": "<paste it here>" }
]
```

> **Do not put a placeholder or a descriptive string here.** Miniflare keys its
> *local* database off this value, so changing it silently swaps which local
> database you are talking to — the symptom is `no such table: accounts` on a
> database you just seeded.

---

## 2. Get it running locally first

```bash
npm run db:init          # schema.sql -> local D1
npm run db:seed          # 2 accounts, 3 months of fixture data
npm run verify:fixture   # 24 assertions on the demo arithmetic
npm test                 # 24 tests
npm run dev
```

`npm run dev` generates `.dev.vars` with a random `SESSION_SECRET` on first run.
It is git-ignored.

**Run `wrangler dev` with no flags.** `npm run dev` already does:

| Command | D1 | AI binding |
|---|---|---|
| `wrangler dev --local` | local ✓ | **forced local → always fails** |
| `wrangler dev --remote` | remote ✗ (loses the local seed) | needs an edge-preview session |
| `wrangler dev` | local ✓ | **remote via proxy ✓** |

`--local` disables remote bindings entirely, so the AI binding reports *"Binding
AI needs to be run remotely"* however the config reads. That error names the
symptom, not the cause.

Open the URL wrangler prints and confirm you get a narrated answer before going
any further. If the deployment is broken you want to already know the
application is not.

---

## 3. Set up the remote database

Same database name, `--remote` instead of `--local`:

```bash
npm run db:init:remote
npm run db:seed:remote
```

Both are **idempotent** — `CREATE TABLE IF NOT EXISTS` and `INSERT OR REPLACE` —
so a run that fails partway can simply be run again. That is deliberate: the
first version of these scripts could only run against a clean database, which
meant a half-applied deploy had no way forward.

Check the data landed:

```bash
npx wrangler d1 execute billing --remote \
  --command "SELECT account_id, name FROM accounts"
```

You should see two rows.

---

## 4. Set the session secret

The session token is HMAC-signed. Generate a secret and set it as a Worker
secret — **not** in `wrangler.jsonc`, which is committed:

```bash
openssl rand -base64 32          # copy the output
npx wrangler secret put SESSION_SECRET
```

Paste the value at the prompt. Do not pass it as a command-line argument, and do
not paste a line with a `#` comment on it — both fail in ways that do not
obviously say "your secret is wrong."

If this is missing or empty, the Worker deploys fine and then fails at runtime
with `Imported HMAC key length (0)`.

---

## 5. Deploy

```bash
npx wrangler deploy
```

The last line of the output is your URL:

```
https://billing-explainer.<your-subdomain>.workers.dev
```

Durable Objects (`AUDIT`, `MCP_AGENT`, `AGENT`, `LIMITER`) and the
`billing-investigation` Workflow are created on first deploy from the bindings
and migrations already in `wrangler.jsonc`. There is nothing to provision by
hand.

---

## 6. Verify the deployment, not just the Worker

```bash
curl https://<your-url>/healthz
```

A 200 here proves the Worker is running. It proves nothing about the three
things that actually break. Open the URL and run these:

| Check | What it proves | If it fails |
|---|---|---|
| Support engineer → Northwind Analytics, July vs June | D1 seed, auth, Workers AI, the whole chain | see below |
| Switch to Customer, ask about Harborlight Media | scope enforcement on the deployed build | — |
| The tools panel drops from 8 entries to 7 | the manifest is per-session, not static | — |

| Symptom | Cause |
|---|---|
| *"No narration was produced (…)"* | D1 and auth are fine; the AI binding is not. The parenthesis names which. |
| An error about accounts or invoices | the remote seed did not land — repeat step 3 |
| `Imported HMAC key length (0)` | the secret did not take — repeat step 4, then redeploy |

---

## What is deliberately not here

**There is no login.** The role selector mints a signed demo token for a chosen
role; it does not authenticate anyone. The claim shape is identical to what
Cloudflare Access or a customer IdP would produce, so the swap is configuration
rather than a rewrite — but until that swap is real, the authorization model is
*demonstrated* rather than *deployed*, and the deployed UI says so on every
screen.

**The demo is rate-limited** to 40 model-backed investigations per hour, held in
a Durable Object. A public URL spends real inference quota; an isolate-local
counter would be a rate limit in appearance only, because Workers are not one
process.

**All data is synthetic** — two fictional accounts, three months, engineered so
the demo question has a layered answer. See
[data-model.md](data-model.md) for the fixture arithmetic.

---

**Next:** [Walkthrough](WALKTHROUGH.md) · [Why it's built this
way](DESIGN.md) · [Tool surface](tool-surface.md) · [Data
model](data-model.md)
