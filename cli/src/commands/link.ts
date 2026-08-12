import readline from 'node:readline/promises';
import { loadConfig } from '../lib/config.js';
import { consoleFetch, errorText } from '../lib/console-api.js';
import { blank, bold, dim, info, success, UserError } from '../lib/log.js';
import { APP_NAME, writeManagedConfig } from '../lib/managed.js';

/**
 * `cloudflarebase link` - connect this directory to a managed console project
 * (docs/managed-service-design.md, Phase B).
 *
 * Picks (or creates) a project, claims an app subdomain - showing the
 * auto-numbered suggestion first when the wanted name is taken, because
 * collisions never fail - and writes `cloudflarebase.json`, which is what
 * flips `cloudflarebase deploy` into managed mode.
 */

interface Flags {
	project?: string;
	app?: string;
	yes?: boolean;
}

function parseFlags(rest: string[]): Flags {
	const flags: Flags = {};
	for (let i = 0; i < rest.length; i += 1) {
		const arg = rest[i];
		if (arg === '--project') flags.project = rest[++i];
		else if (arg === '--app') flags.app = rest[++i];
		else if (arg === '--yes' || arg === '-y') flags.yes = true;
		else throw new UserError(`Unknown flag "${arg}".`);
	}
	return flags;
}

interface RegistryProject {
	id: string;
	name: string;
	parentId: string | null;
}

export async function linkCommand(projectDir: string, rest: string[]): Promise<void> {
	const flags = parseFlags(rest);
	const config = await loadConfig();

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		// 1. Pick or create the ROOT project (branches are decided per deploy).
		let projectId = flags.project;
		if (!projectId) {
			const response = await consoleFetch(config, '/api/registry/projects');
			if (!response.ok) {
				throw new UserError(`Could not list projects: ${await errorText(response)}`);
			}
			const { projects } = (await response.json()) as { projects: RegistryProject[] };
			const roots = projects.filter((project) => !project.parentId);

			if (roots.length) {
				info('Projects on this console:');
				roots.forEach((project, index) => {
					info(`  ${dim(`${index + 1}.`)} ${bold(project.id)} ${dim(project.name)}`);
				});
				blank();
			}
			const answer = (
				await rl.question('Project (number to pick, or a new id to create): ')
			).trim();
			const picked = roots[Number(answer) - 1];
			if (picked) {
				projectId = picked.id;
			} else if (answer) {
				const created = await consoleFetch(config, '/api/registry/projects', {
					method: 'POST',
					body: JSON.stringify({ id: answer, name: answer })
				});
				if (!created.ok) {
					throw new UserError(`Could not create "${answer}": ${await errorText(created)}`);
				}
				projectId = answer;
				success(`Created project ${bold(answer)}`);
			} else {
				throw new UserError('Which project?', 'Pick a number or type a new project id.');
			}
		}
		if (projectId.includes('--')) {
			throw new UserError('Link the ROOT project - branches are decided per deploy.');
		}

		// 2. Choose the app name, defaulting to the project id.
		let appName = flags.app;
		if (!appName) {
			const suggestion = APP_NAME.test(projectId) ? projectId : undefined;
			const answer = (
				await rl.question(`App name${suggestion ? ` [${suggestion}]` : ''}: `)
			).trim();
			appName = answer || suggestion || '';
		}
		if (!APP_NAME.test(appName) || appName.includes('--')) {
			throw new UserError(
				`"${appName}" is not a valid app name.`,
				'Use 3-48 lowercase letters, numbers, and hyphens (no "--").'
			);
		}

		// 3. Preview the claim, then take it. Taken names auto-number rather
		// than fail, so the preview is what makes the numbering consensual in
		// an interactive session - CI deploys just take it.
		const preview = await consoleFetch(config, `/api/projects/${projectId}/hosting/claims`, {
			method: 'POST',
			body: JSON.stringify({ app: appName, dry: true })
		});
		if (!preview.ok) {
			throw new UserError(`Could not claim "${appName}": ${await errorText(preview)}`);
		}
		const suggested = (await preview.json()) as { subdomain: string };
		if (suggested.subdomain !== appName) {
			info(
				`${bold(appName)} is taken - the next free subdomain is ${bold(suggested.subdomain)}.`
			);
		}
		if (!flags.yes) {
			const confirm = (
				await rl.question(`Claim ${bold(suggested.subdomain)}.cfbase.dev? [Y/n] `)
			).trim();
			if (confirm && !/^y(es)?$/i.test(confirm)) {
				throw new UserError('Nothing claimed.');
			}
		}
		const claim = await consoleFetch(config, `/api/projects/${projectId}/hosting/claims`, {
			method: 'POST',
			body: JSON.stringify({ app: appName })
		});
		if (!claim.ok) {
			throw new UserError(`Could not claim "${appName}": ${await errorText(claim)}`);
		}
		const claimed = (await claim.json()) as { subdomain: string };

		// 4. Write the marker that flips `deploy` into managed mode.
		const file = await writeManagedConfig(projectDir, {
			project: projectId,
			app: appName,
			origin: config.origin
		});

		blank();
		success(`Linked to ${bold(projectId)} as ${bold(claimed.subdomain)}`);
		info(`  ${dim('·')} ${file} written - commit it; \`cloudflarebase deploy\` is now managed.`);
		info(
			`  ${dim('·')} Root deploys serve at ${bold(`${claimed.subdomain}.cfbase.dev`)}; a branch <b> serves at ${claimed.subdomain}-<b>.cfbase.dev.`
		);
	} finally {
		rl.close();
	}
}
