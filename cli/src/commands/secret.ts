import readline from 'node:readline/promises';
import { loadConfig } from '../lib/config.js';
import { blank, bold, success, UserError } from '../lib/log.js';
import {
	hostingFetch,
	readManagedConfig,
	resolveGitBranch,
	sanitizeBranchName,
	targetProjectId
} from '../lib/managed.js';

/**
 * `cloudflarebase secret put <NAME>` - set a secret on the initialized app
 * (`wrangler secret put` vocabulary on purpose).
 *
 * The console PATCHes the deployed script's settings with `keep_bindings`,
 * so redeploys never drop what is set here. Operator sessions only - deploy
 * tokens deliberately cannot write secrets.
 */
export async function secretCommand(projectDir: string, rest: string[]): Promise<void> {
	const [subcommand, name, ...args] = rest;
	if (subcommand !== 'put' || !name) {
		throw new UserError(
			'Usage: cloudflarebase secret put <NAME> [--value <value>] [--branch <name>]'
		);
	}
	if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
		throw new UserError(`"${name}" is not a valid secret name.`, 'Use UPPER_SNAKE_CASE.');
	}

	let value: string | undefined;
	let branchFlag: string | undefined;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === '--value') value = args[++i];
		else if (arg === '--branch') branchFlag = args[++i];
		else throw new UserError(`Unknown flag "${arg}".`);
	}

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

	if (value === undefined) {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		try {
			value = await rl.question(`Value for ${bold(name)}: `);
		} finally {
			rl.close();
		}
	}
	if (!value) throw new UserError('The secret value is empty.');

	const gitBranch = branchFlag ?? (await resolveGitBranch(projectDir));
	const branch = gitBranch ? sanitizeBranchName(gitBranch) : null;
	const target = targetProjectId(managed.project, branch);

	const response = await hostingFetch(
		managed.origin,
		config.token,
		`/api/projects/${target}/hosting/apps/${managed.app}/secrets`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name, value })
		}
	);
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as { error?: string } | null;
		throw new UserError(
			`Setting the secret failed: ${body?.error ?? `the console responded ${response.status}`}`
		);
	}

	blank();
	success(`Secret ${bold(name)} set on ${bold(managed.app)}${branch ? ` (${branch})` : ''}`);
}
