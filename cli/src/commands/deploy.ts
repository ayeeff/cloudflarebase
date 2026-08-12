import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { blank, bold, dim, info, step, success, UserError } from '../lib/log.js';
import {
	collectAssets,
	findAssetsDirectory,
	hostingFetch,
	readManagedConfig,
	readUserWranglerConfig,
	resolveGitBranch,
	sanitizeBranchName,
	targetProjectId,
	type ManagedConfig
} from '../lib/managed.js';
import { run, runOrFail } from '../lib/run.js';
import { readTrustedOrigins } from '../lib/wrangler-config.js';

/**
 * `cloudflarebase deploy` - deploy, branching on context:
 *
 * - `cloudflarebase.json` present (written by bare `cloudflarebase init`): MANAGED
 *   deploy against the console's hosting API. The git branch decides the
 *   target: the default branch deploys the root, anything else deploys
 *   `<root>--<branch>` (auto-created), so preview-per-git-branch falls out.
 * - otherwise: the self-hosted wrangler path, unchanged.
 */
export async function deployCommand(projectDir: string, rest: string[] = []): Promise<void> {
	const managed = await readManagedConfig(projectDir);
	if (managed) {
		await managedDeploy(projectDir, managed, parseManagedFlags(rest));
		return;
	}
	if (rest.length) {
		throw new UserError(
			'Deploy flags need an initialized project.',
			'Run `cloudflarebase init` first - flags like --branch only apply to managed deploys.'
		);
	}
	await selfHostedDeploy(projectDir);
}

interface ManagedFlags {
	branch?: string;
	token?: string;
}

function parseManagedFlags(rest: string[]): ManagedFlags {
	const flags: ManagedFlags = {};
	for (let i = 0; i < rest.length; i += 1) {
		const arg = rest[i];
		if (arg === '--branch') flags.branch = rest[++i];
		else if (arg === '--token') flags.token = rest[++i];
		else throw new UserError(`Unknown flag "${arg}".`);
	}
	return flags;
}

/** The bundling output directory; keep it out of version control. */
const BUNDLE_DIR = '.cloudflarebase/dist';

async function managedDeploy(
	projectDir: string,
	managed: ManagedConfig,
	flags: ManagedFlags
): Promise<void> {
	// CI rides a deploy token (env var or --token); interactive sessions ride
	// the stored login against the same console the directory was linked to.
	let token = flags.token ?? process.env.CLOUDFLAREBASE_DEPLOY_TOKEN;
	if (!token) {
		const config = await loadConfig();
		if (config.origin !== managed.origin) {
			throw new UserError(
				`This directory is linked to ${managed.origin}, but you are signed in to ${config.origin}.`,
				`Run \`cloudflarebase login ${managed.origin}\` (or set CLOUDFLAREBASE_DEPLOY_TOKEN).`
			);
		}
		token = config.token;
	}

	// Git branch -> target project id. `--branch` overrides; `main` aliases
	// the root and never appears in a URL.
	const gitBranch = flags.branch ?? (await resolveGitBranch(projectDir));
	const branch = gitBranch ? sanitizeBranchName(gitBranch) : null;
	const target = targetProjectId(managed.project, branch);

	if (target !== managed.project) {
		// Ensure the branch row exists (409 = already does). This is one of the
		// two endpoints a deploy token is valid on, so CI's new git branches
		// mint their preview project on first deploy.
		const created = await hostingFetch(
			managed.origin,
			token,
			`/api/projects/${managed.project}/branches`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ branch })
			}
		);
		if (!created.ok && created.status !== 409) {
			throw new UserError(`Could not create branch "${branch}": ${await failureText(created)}`);
		}
		step(`Deploying branch ${bold(branch!)} (${target})`);
	} else {
		step(`Deploying ${bold(managed.project)}`);
	}

	// Bundle the Worker when the user's wrangler config declares one -
	// wrangler does the bundling (--dry-run --outdir), we upload the output.
	const wrangler = await readUserWranglerConfig(projectDir);
	const form = new FormData();
	let mainModule: string | undefined;
	let moduleCount = 0;
	if (wrangler?.main) {
		step('Bundling the Worker with wrangler');
		await runOrFail('npx', ['wrangler', 'deploy', '--dry-run', `--outdir=${BUNDLE_DIR}`], {
			cwd: projectDir,
			capture: true,
			failure: 'wrangler bundling failed.'
		});
		const outDir = path.join(projectDir, BUNDLE_DIR);
		const emitted = (await readdir(outDir)).filter((name) => /\.(?:js|mjs)$/.test(name));
		if (!emitted.length) {
			throw new UserError('wrangler emitted no JavaScript bundle.');
		}
		const entryGuess = `${path.basename(wrangler.main).replace(/\.[jt]sx?$/, '')}.js`;
		mainModule =
			emitted.length === 1
				? emitted[0]
				: (emitted.find((name) => name === entryGuess) ?? 'index.js');
		if (!mainModule || !emitted.includes(mainModule)) {
			throw new UserError(
				'Could not identify the entry module in the wrangler bundle.',
				`Emitted: ${emitted.join(', ')}`
			);
		}
		for (const name of emitted) {
			const bytes = await readFile(path.join(outDir, name));
			form.append(`module:${name}`, new Blob([new Uint8Array(bytes)]), name);
			moduleCount += 1;
		}
	}

	// Assets: wrangler's directory, the cloudflarebase.json override, or the
	// conventional build outputs. A bare assets directory deploys as an
	// assets-only Worker.
	const assetsDir = await findAssetsDirectory(
		projectDir,
		managed.assets,
		wrangler?.assetsDirectory
	);
	let assetCount = 0;
	if (assetsDir) {
		for (const file of await collectAssets(assetsDir)) {
			form.append(
				`asset:${file.name}`,
				new Blob([new Uint8Array(file.bytes)]),
				path.basename(file.name)
			);
			assetCount += 1;
		}
	}
	if (!moduleCount && !assetCount) {
		throw new UserError(
			'Nothing to deploy - no Worker main and no assets directory.',
			'Build your app first, or set "assets" in cloudflarebase.json.'
		);
	}

	form.append(
		'meta',
		JSON.stringify({
			mainModule,
			compatibilityDate: wrangler?.compatibilityDate,
			compatibilityFlags: wrangler?.compatibilityFlags,
			vars: managed.vars
		})
	);

	step(`Uploading ${moduleCount} module(s) and ${assetCount} asset(s)`);
	const response = await hostingFetch(
		managed.origin,
		token,
		`/api/projects/${target}/hosting/apps/${managed.app}/deploys`,
		{ method: 'POST', body: form }
	);
	if (!response.ok) {
		throw new UserError(`Deploy failed: ${await failureText(response)}`);
	}
	const result = (await response.json()) as {
		subdomain: string;
		url: string | null;
		deploy: { status: string };
	};

	blank();
	success(result.url ? `Deployed to ${bold(result.url)}` : `Deployed as ${bold(result.subdomain)}`);
	if (result.subdomain !== (branch ? `${managed.app}-${branch}` : managed.app)) {
		// Auto-numbering claimed a neighbor - say so, never hide it.
		info(`  ${dim('·')} The wanted name was taken; this app is claimed as ${result.subdomain}.`);
	}
	if (result.deploy.status === 'stub') {
		info(`  ${dim('·')} This console records deploys without a dispatch namespace (stub mode).`);
	}
}

async function failureText(response: Response): Promise<string> {
	if (response.status === 401) {
		return 'the credential was refused - the deploy token may be revoked, or sign in again';
	}
	const body = (await response.json().catch(() => null)) as { error?: string } | null;
	return body?.error ?? `the console responded ${response.status}`;
}

/**
 * The self-hosted wrangler path - unchanged. There is nothing to configure
 * before sign-in works: the agent trusts the deployment's own origin
 * automatically, so a fresh deploy is usable the moment the URL exists.
 */
async function selfHostedDeploy(projectDir: string): Promise<void> {
	const configPath = path.join(projectDir, 'wrangler.jsonc');
	let configText: string;
	try {
		configText = await readFile(configPath, 'utf8');
	} catch {
		throw new UserError(
			'No wrangler.jsonc found - nothing to deploy.',
			'Run `cloudflarebase init <name>` to scaffold a project, or bare `cloudflarebase init` for managed hosting.'
		);
	}

	// Fail on missing auth before deploying, not mid-flight with piped output.
	const whoami = await run('npx', ['wrangler', 'whoami'], { cwd: projectDir, capture: true });
	if (whoami.code !== 0 || /not authenticated/i.test(whoami.stdout + whoami.stderr)) {
		throw new UserError(
			'Wrangler is not signed in to a Cloudflare account.',
			'Run `npx wrangler login` (or set CLOUDFLARE_API_TOKEN), then deploy again.'
		);
	}

	step('Deploying');
	const result = await runOrFail('npx', ['wrangler', 'deploy'], {
		cwd: projectDir,
		capture: true,
		failure: 'wrangler deploy failed.'
	});
	process.stdout.write(result.stdout);

	const url = (result.stdout + result.stderr).match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];
	const trusted = readTrustedOrigins(configText);

	blank();
	success(url ? `Deployed to ${url}` : 'Deployed.');
	info(`  ${dim('·')} Sign-in works from the deployed URL right away; it trusts its own origin.`);
	if (trusted !== '') {
		info(`  ${dim('·')} Extra trusted origins: ${trusted}`);
	} else {
		info(
			`  ${dim('·')} Serving the UI from another domain? Add it to TRUSTED_ORIGINS in wrangler.jsonc.`
		);
	}
}
