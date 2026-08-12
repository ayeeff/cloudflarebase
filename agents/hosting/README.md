# @cloudflarebase/hosting

Apps and functions on Cloudflare Workers for Platforms - static assets and
server code in one deploy, served at your subdomain. The hosting primitive
behind [Cloudflarebase](https://github.com/cloudflarebase/cloudflarebase).

One `HostingAgent` Durable Object per project orchestrates deploys (asset
upload sessions, script puts, per-script tags and limits) while the same
worker serves every app on a wildcard domain by dispatching the host label
straight into the namespace - the script name IS the subdomain, so serving
needs zero lookups.

## Install

```sh
npx @cloudflarebase/cli add hosting
```

The CLI installs this package, merges `template/wrangler-fragment.jsonc` into
your `wrangler.jsonc`, prepends the entrypoint re-export, and reruns
`wrangler types`. Workers for Platforms is a paid Cloudflare add-on; the
fragment's header documents the manual steps that turn recorded deploys into
served apps (dispatch namespace, API token, wildcard route).

## What it serves

- An "app" is one user Worker in the dispatch namespace: a static site, an
  SSR frontend, backend functions, or all three in one artifact (modules plus
  an asset manifest).
- Deploys go through the Cloudflarebase console (bare `cloudflarebase init`,
  then `cloudflarebase deploy`), which resolves the subdomain claim in its
  control plane and pushes it here - this agent owns no global state.
- Every script is uploaded with a `pid-<projectId>` tag (project erase
  deletes by tag), fixed CPU/subrequest limits applied at dispatch, and
  injected `PROJECT_ID` / `CLOUDFLAREBASE_URL` vars so the SDK works out of
  the box.

## License

Apache-2.0. See NOTICE.
