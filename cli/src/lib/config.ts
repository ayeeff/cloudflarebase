import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UserError } from './log.js';

/**
 * Where `cloudflarebase login` parks the console origin and the operator
 * session token. The token is an ordinary console session - visible in the
 * console's sessions list and revocable there - so the file holds nothing a
 * sign-out cannot invalidate.
 */

export interface CliConfig {
	origin: string;
	token: string;
}

const configDir = (): string => path.join(os.homedir(), '.cloudflarebase');
export const configPath = (): string => path.join(configDir(), 'config.json');

export async function saveConfig(config: CliConfig): Promise<string> {
	await mkdir(configDir(), { recursive: true });
	const file = configPath();
	await writeFile(file, `${JSON.stringify(config, null, '\t')}\n`, 'utf8');
	// Best effort: POSIX perms tighten the file; Windows ACLs differ and a
	// failure here must not fail the login.
	try {
		await chmod(file, 0o600);
	} catch {
		/* ignore */
	}
	return file;
}

export async function loadConfig(): Promise<CliConfig> {
	try {
		const raw = JSON.parse(await readFile(configPath(), 'utf8')) as Partial<CliConfig>;
		if (typeof raw.origin === 'string' && typeof raw.token === 'string') {
			return { origin: raw.origin, token: raw.token };
		}
	} catch {
		/* fall through to the error below */
	}
	throw new UserError(
		'Not signed in to a console.',
		'Run `cloudflarebase login <console-url>` first.'
	);
}

export async function deleteConfig(): Promise<void> {
	await rm(configPath(), { force: true });
}
