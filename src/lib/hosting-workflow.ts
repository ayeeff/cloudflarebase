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
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install
      # Adjust to your stack; skipped when package.json has no build script.
      - run: npm run build --if-present
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
    permissions:
      contents: read
      # Mints the identity token the console verifies. Without it the deploy
      # has no credential at all and will be refused.
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install
      # Adjust to your stack; skipped when package.json has no build script.
      - run: npm run build --if-present
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
