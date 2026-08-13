/**
 * The official GitHub Actions deploy workflow (docs/managed-service-design.md,
 * Phase B) - Workers-Builds-style push-to-deploy WITHOUT us running a build
 * farm: GitHub's runners do the user's build, `cloudflarebase deploy` ships
 * the output with the repo's deploy token. Single-sourced here so the
 * dashboard's Connect GitHub card can never drift from what we document.
 *
 * Branch mapping happens in the CLI: the default git branch deploys the root
 * project, any other branch deploys `<root>--<branch>` (auto-created), so a
 * preview per git branch falls out. The two env vars exist because
 * actions/checkout leaves a detached HEAD - git alone cannot name the branch.
 */

export const DEPLOY_TOKEN_SECRET_NAME = 'CLOUDFLAREBASE_DEPLOY_TOKEN';
export const WORKFLOW_FILENAME = '.github/workflows/cloudflarebase.yml';

/**
 * Everything between checkout and deploy, shared by both workflows below so
 * the two can never drift.
 *
 * This runs on every push, so the install is worth tuning: restoring `~/.npm`
 * and using `npm ci` turns a cold ~60s install into ~15s. Both are
 * CONDITIONAL, because a connected repository is not guaranteed to have a
 * lockfile - and `cache: npm` with no lockfile FAILS the job outright rather
 * than quietly skipping the cache, which would break the deploy we are
 * supposed to be speeding up.
 */
const buildSteps = `      - uses: actions/setup-node@v4
        with:
          node-version: 22
          # Restores ~/.npm. That also holds npx's cache, so the deploy step
          # reuses it - npx still checks the registry for a newer CLI, since a
          # name-only spec is re-resolved on every run.
          cache: \${{ hashFiles('package-lock.json', 'npm-shrinkwrap.json') != '' && 'npm' || '' }}
      - name: Install dependencies
        if: hashFiles('package.json') != ''
        # ci skips dependency resolution entirely; the fallback covers a
        # lockfile that has drifted, which ci refuses and install repairs.
        # --no-audit/--no-fund drop two registry round trips nothing reads here.
        run: |
          if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then
            npm ci --prefer-offline --no-audit --no-fund || npm install --no-audit --no-fund
          else
            npm install --no-audit --no-fund
          fi
      # Adjust to your stack; skipped when package.json has no build script.
      - name: Build
        if: hashFiles('package.json') != ''
        # Bounded separately from the job so a hang is ATTRIBUTED. A job-level
        # timeout alone reports "the job was cancelled", which does not say
        # which step stopped - and a build that never exits is the likeliest
        # thing to stop here, since the runner cannot start the deploy until
        # this process exits.
        timeout-minutes: 10
        run: |
          # Node picks its own heap limit from the machine, which is fine
          # until a large SSR build reaches it - and reaching it does not
          # crash cleanly, it degrades into GC thrashing that looks exactly
          # like a hang, for hours. Set it explicitly to two thirds of this
          # runner's RAM: enough that a bigger runner is actually used,
          # conservative enough that the heap plus everything else stays
          # inside the box (overshooting trades a clean heap error for the
          # OOM killer, which is the worse failure).
          # Guarded on \`free\` so a non-Linux runs-on still builds, and
          # appended so a NODE_OPTIONS you set yourself still wins.
          if command -v free >/dev/null 2>&1; then
            export NODE_OPTIONS="--max-old-space-size=$(free -m | awk '/^Mem:/ {print int($2 * 2 / 3)}') $NODE_OPTIONS"
          fi
          npm run build --if-present`;

export function deployWorkflowYaml(): string {
	return `# Deploys this repository to Cloudflarebase on every push.
# The default branch deploys production; any other branch deploys an
# isolated preview at <app>-<branch>.cfbase.dev. Requires the
# ${DEPLOY_TOKEN_SECRET_NAME} repository secret (minted on the Hosting page).
name: Deploy to Cloudflarebase

on:
  push:
    branches: ['**']

concurrency:
  group: cloudflarebase-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    # GitHub's default is 360 minutes. A deploy that has not finished in 15 is
    # not slow, it is stuck - a build waiting on a prompt, a prerender fetching
    # a URL that never answers - and six hours of billed minutes is a bad way
    # to find that out. Raise it if a genuine build needs longer.
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
${buildSteps}
      - name: Deploy
        run: npx --yes @cloudflarebase/cli deploy
        env:
          ${DEPLOY_TOKEN_SECRET_NAME}: \${{ secrets.${DEPLOY_TOKEN_SECRET_NAME} }}
          CLOUDFLAREBASE_GIT_BRANCH: \${{ github.ref_name }}
          CLOUDFLAREBASE_DEFAULT_BRANCH: \${{ github.event.repository.default_branch }}
`;
}

export interface ConnectedWorkflowInput {
	/** Console origin - also the OIDC audience the token is minted for. */
	origin: string;
	/** ROOT project id; the branch is derived from the pushed ref. */
	projectId: string;
	appName: string;
}

/**
 * The workflow written INTO the repository by the GitHub App (`build` mode).
 *
 * Two differences from the manual one above, both consequences of the App
 * knowing who this repo is:
 *
 * - **No secret.** `id-token: write` lets the job mint a short-lived OIDC
 *   token describing the repository; the console verifies it against
 *   GitHub's public keys and looks the repository up in its connection
 *   table. Nothing is stored in the repo, so nothing can leak or need
 *   rotating. The CLI mints it - there is no extra step here.
 * - **No `cloudflarebase.json` needed.** The console knows the project and
 *   app at write time and passes them as env, so connecting in the console
 *   is the whole setup: the operator never runs the CLI locally.
 */
export function connectedWorkflowYaml(input: ConnectedWorkflowInput): string {
	return `# Deploys this repository to Cloudflarebase on every push.
# Managed by Cloudflarebase - reconnecting the repository rewrites this file.
# The default branch deploys production; any other branch deploys an isolated
# preview at <app>-<branch>. Authentication is GitHub's OIDC token, so this
# repository holds no Cloudflarebase secret.
name: Deploy to Cloudflarebase

on:
  push:
    branches: ['**']

concurrency:
  group: cloudflarebase-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    # GitHub's default is 360 minutes. A deploy that has not finished in 15 is
    # not slow, it is stuck - a build waiting on a prompt, a prerender fetching
    # a URL that never answers - and six hours of billed minutes is a bad way
    # to find that out. Raise it if a genuine build needs longer.
    timeout-minutes: 15
    permissions:
      contents: read
      # Mints the identity token the console verifies. Without it the deploy
      # has no credential at all and will be refused.
      id-token: write
    steps:
      - uses: actions/checkout@v4
${buildSteps}
      - name: Deploy
        run: npx --yes @cloudflarebase/cli deploy
        env:
          CLOUDFLAREBASE_URL: ${input.origin}
          CLOUDFLAREBASE_PROJECT: ${input.projectId}
          CLOUDFLAREBASE_APP: ${input.appName}
          CLOUDFLAREBASE_GIT_BRANCH: \${{ github.ref_name }}
          CLOUDFLAREBASE_DEFAULT_BRANCH: \${{ github.event.repository.default_branch }}
`;
}

/** GitHub's new-file editor with the workflow pre-filled - the manual path,
 * for consoles with no GitHub App configured. */
export function workflowCreateUrl(repo: string): string {
	return `https://github.com/${repo}/new/main?filename=${encodeURIComponent(WORKFLOW_FILENAME)}&value=${encodeURIComponent(deployWorkflowYaml())}`;
}

/** Where the deploy token gets pasted. */
export function secretsUrl(repo: string): string {
	return `https://github.com/${repo}/settings/secrets/actions/new`;
}
