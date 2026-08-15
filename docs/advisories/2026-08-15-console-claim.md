# Unauthenticated console takeover on unclaimed self-hosted installs

Draft for a GitHub Security Advisory. Publish from the Security tab
(`Advisories` → `New draft advisory`); nothing here is posted automatically.

- **Package:** the self-hosted dashboard (this repository). The published npm
  packages - `@cloudflarebase/auth`, `@cloudflarebase/db`,
  `@cloudflarebase/hosting`, `@cloudflarebase/cli` - are **not affected**: the
  claim only means something where a console exists, and a consumer install
  has none.
- **Affected:** every self-hosted deployment whose console had not yet been
  claimed, up to and including commit `510d190`.
- **Fixed in:** the commit that adds `src/lib/server/console-setup.ts`.
- **Severity:** High. Full administrative control of the deployment, remotely,
  with no authentication and no user interaction.
- **cloudflarebase.com is not affected.** Its console was claimed long before
  this, and a claimed console was never reachable this way.

## Summary

The first-run console claim was gated on `count(user) === 0` - a fact about the
world, not about the person claiming. Anyone who reached an unclaimed install's
`/login` could register the first account, and `ensureConsoleAdmin` then
promoted that account to `admin`: the operator plane, every project, every
other operator account.

Arriving first was the entire credential. Deployment URLs are not secrets -
this repository's default Worker name is `cloudflarebase`, so the workers.dev
hostname of a stock install is guessable, and that is exactly how it was found.

## Impact

On an install that was deployed but not yet claimed, an unauthenticated
attacker could:

- create the owner account and become console `admin`;
- read, modify and delete every project on the deployment, including its user
  data;
- list, delete and re-role every operator account created afterwards;
- lock the legitimate operator out permanently - the real owner arriving later
  saw a console that already had an owner, with no way back in.

A console that was already claimed was never exposed: the claim closes behind
the first account.

## Patches

Claiming now requires proof of control of the deployment itself:
`CONSOLE_SETUP_TOKEN`, set with `wrangler secret put`, which needs Cloudflare
account credentials and travels over no network path an attacker can observe.
Unlocking alone grants nothing - the console is claimed only once registration
completes.

Enforcement lives in the console guard rather than the proxy route, because
sign-up, social sign-in and the OAuth callback are all reachable through the
`/agents/*` passthrough as well, and both doors classify as public. The matcher
normalises percent-encoding and dot segments first, so `sign-up%2Femail` cannot
mean one thing to the guard and another to the agent.

A time-boxed "claimable for N minutes after deploy" window was considered and
rejected: it is a shorter race, not the absence of one.

## Workarounds

None. Update, or claim the console immediately after deploying and confirm the
owner account is yours.

## What to do

1. **Check who owns your console.** Sign in and open
   `/dashboard/console` (visible to console admins). If there is an account you
   do not recognise, you were claimed by someone else.
2. **Update and redeploy** (`git pull && npm run deploy:all`).
3. **Set a setup token:** `npx wrangler secret put CONSOLE_SETUP_TOKEN` on the
   dashboard Worker - at least 24 characters. Shorter values are refused rather
   than accepted as a weak credential.
4. **If a stranger owns your console,** reclaim it. This erases every operator
   account, session and organization on the deployment - project data is
   untouched, since each project is its own instance:

   ```bash
   # unlock, keeping the cookie the unlock returns
   curl -sc jar.txt -X POST https://<your-console>/api/console/setup \
     -H 'content-type: application/json' -d '{"token":"<your token>"}'

   # then reclaim
   curl -sb jar.txt -X DELETE https://<your-console>/api/console/setup \
     -H 'content-type: application/json' \
     -d '{"confirm":"erase-console-operators"}'
   ```

   Then open `/login`, enter the token, and create your owner account. Projects
   that belonged to the previous owner's organization are released to
   unowned - visible to any operator on your install - so nothing is stranded
   behind an organization that no longer exists.

5. **Assume anything the attacker could read was read.** Rotate per-project
   secrets and OAuth credentials you had configured, and check the project list
   for anything you did not create.

## Timeline

- **2026-08-15** - reported: a third party's install was claimed by guessing its
  workers.dev URL.
- **2026-08-15** - fix written, reviewed against the self-hosted, managed and
  demo deployment shapes, and verified against a live stack.

## Credit

Reported by the maintainer after reproducing it against an unrelated
deployment. If you found this independently, open a draft advisory (see
`SECURITY.md`) and you will be credited here.
