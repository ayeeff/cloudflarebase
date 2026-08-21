import readline from 'node:readline/promises';
import { loadConfig } from '../lib/config.js';
import { blank, bold, dim, info, success, UserError } from '../lib/log.js';
import {
	hostingFetch,
	readManagedConfig,
	resolveGitBranch,
	sanitizeBranchName,
	targetProjectId
} from '../lib/managed.js';

/**
 * `cloudflarebase secret put|list|delete` - secrets on the initialized app
 * (`wrangler secret` vocabulary on purpose).
 *
 * `put` PATCHes the deployed script's settings with `keep_bindings`, so
 * redeploys never drop what is set here; values are write-through and
 * unrecoverable, which is why `list` shows names only. Operator sessions only
 * - deploy tokens deliberately cannot touch secrets.
 */

const USAGE = [
	'Usage: cloudflarebase secret put <NAME> [--value <value>] [--branch <name>]',
	'       cloudflarebase secret list [--branch <name>]',
	'       cloudflarebase secret delete <NAME> [--branch <name>]'
].join('\n');

interface SecretTarget {
	origin: string;
	token: string;
	app: string;
	/** The branch-resolved registry project id the request dials. */
	projectId: string;
	/** The short branch name, for messages; null on the root. */
	branch: string | null;
}

/** The shared preamble: managed config, matching login, branch resolution. */
async function resolveTarget(projectDir: string, branchFlag?: string): Promise<SecretTarget> {
	const managed = await readManagedConfig(projectDir);
	if (!managed) {
		throw new UserError('This directory is not initialized.', 'Run `cloudflarebase init` first.');
	}
	const config = await loadConfig();
	if (config.origin !== managed.origin) {
		throw new UserError(
			`This directory is linked to ${managed.origin}, but you are signed in to ${config.origin}.`,
			`Run \`cloudflarebase login ${managed.origin}\` first.`
		);
	}
	const gitBranch = branchFlag ?? (await resolveGitBranch(projectDir));
	const branch = gitBranch ? sanitizeBranchName(gitBranch) : null;
	return {
		origin: managed.origin,
		token: config.token,
		app: managed.app,
		projectId: targetProjectId(managed.project, branch),
		branch
	};
}

function assertSecretName(name: string | undefined): string {
	if (!name) throw new UserError(USAGE);
	if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
		throw new UserError(`"${name}" is not a valid secret name.`, 'Use UPPER_SNAKE_CASE.');
	}
	return name;
}

async function fail(response: Response, verb: string): Promise<never> {
	const body = (await response.json().catch(() => null)) as { error?: string } | null;
	throw new UserError(
		`${verb} failed: ${body?.error ?? `the console responded ${response.status}`}`
	);
}

export async function secretCommand(projectDir: string, rest: string[]): Promise<void> {
	const [subcommand, ...args] = rest;

	if (subcommand === 'put') {
		const name = assertSecretName(args.shift());
		let value: string | undefined;
		let branchFlag: string | undefined;
		for (let i = 0; i < args.length; i += 1) {
			const arg = args[i];
			if (arg === '--value') value = args[++i];
			else if (arg === '--branch') branchFlag = args[++i];
			else throw new UserError(`Unknown flag "${arg}".`);
		}

		const target = await resolveTarget(projectDir, branchFlag);
		if (value === undefined) {
			const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
			try {
				value = await rl.question(`Value for ${bold(name)}: `);
			} finally {
				rl.close();
			}
		}
		if (!value) throw new UserError('The secret value is empty.');

		const response = await hostingFetch(
			target.origin,
			target.token,
			`/api/projects/${target.projectId}/hosting/apps/${target.app}/secrets`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name, value })
			}
		);
		if (!response.ok) await fail(response, 'Setting the secret');

		blank();
		success(
			`Secret ${bold(name)} set on ${bold(target.app)}${target.branch ? ` (${target.branch})` : ''}`
		);
		return;
	}

	if (subcommand === 'list') {
		let branchFlag: string | undefined;
		for (let i = 0; i < args.length; i += 1) {
			if (args[i] === '--branch') branchFlag = args[++i];
			else throw new UserError(`Unknown flag "${args[i]}".`);
		}

		const target = await resolveTarget(projectDir, branchFlag);
		const response = await hostingFetch(
			target.origin,
			target.token,
			`/api/projects/${target.projectId}/hosting/apps/${target.app}/secrets`
		);
		if (!response.ok) await fail(response, 'Listing secrets');
		const body = (await response.json()) as {
			secrets: { name: string; updatedAt: string }[];
		};

		blank();
		if (!body.secrets.length) {
			info(
				`No secrets on ${bold(target.app)}${target.branch ? ` (${target.branch})` : ''}. ` +
					dim('Set one with `cloudflarebase secret put <NAME>`.')
			);
			return;
		}
		for (const secret of body.secrets) {
			info(`${bold(secret.name)}  ${dim(`updated ${secret.updatedAt.slice(0, 10)}`)}`);
		}
		return;
	}

	if (subcommand === 'delete') {
		const name = assertSecretName(args.shift());
		let branchFlag: string | undefined;
		for (let i = 0; i < args.length; i += 1) {
			if (args[i] === '--branch') branchFlag = args[++i];
			else throw new UserError(`Unknown flag "${args[i]}".`);
		}

		const target = await resolveTarget(projectDir, branchFlag);
		const response = await hostingFetch(
			target.origin,
			target.token,
			`/api/projects/${target.projectId}/hosting/apps/${target.app}/secrets/${name}`,
			{ method: 'DELETE' }
		);
		if (!response.ok) await fail(response, 'Deleting the secret');

		blank();
		success(
			`Secret ${bold(name)} deleted from ${bold(target.app)}${target.branch ? ` (${target.branch})` : ''}`
		);
		return;
	}

	throw new UserError(USAGE);
}
