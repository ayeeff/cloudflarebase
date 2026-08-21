import { projectBranchesSchema, registryProjectSchema } from '$lib/agents';
import { createBranchSchema } from '$lib/schemas/auth';
import { jsonBody, jsonResponse, ref, UNAUTHORIZED, type AgentOpenApiModule } from './shared';

/**
 * The console's own (control-plane) contribution to the per-project document:
 * project branches. Branches are minted by the
 * registry, not by an agent - a branch is a full project whose id is
 * `<root>--<branch>`, so every other endpoint in this document works on a
 * branch by swapping the project id in the base URL.
 */

const CONSOLE_TAG = 'Console';

export const consoleOpenApi: AgentOpenApiModule = {
	// The Console tag is declared by the auth module; this module only adds to it.
	tags: [],
	schemas: [registryProjectSchema, projectBranchesSchema, createBranchSchema],
	paths: {
		'/branches': {
			get: {
				tags: [CONSOLE_TAG],
				summary: 'List branches',
				description:
					'Branches of this root project, oldest first. A branch of `myapp` is a fully isolated project with id `myapp--<branch>` - own users, collections, tables, and keys.',
				security: [{ sessionCookie: [] }],
				responses: {
					'200': jsonResponse(projectBranchesSchema, 'The branches.'),
					'401': UNAUTHORIZED
				}
			},
			post: {
				tags: [CONSOLE_TAG],
				summary: 'Create a branch',
				description:
					'Mints `<root>--<branch>` as a full project row. The branch starts empty, like a fresh project; agent instances spawn lazily on first touch. Only root projects can be branched, and `<root>--<branch>` must fit the 48-character project-id ceiling.',
				security: [{ sessionCookie: [] }],
				requestBody: jsonBody(createBranchSchema, 'The branch to create.'),
				responses: {
					'201': {
						description: 'Branch created.',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: { branch: ref(registryProjectSchema) },
									required: ['branch']
								}
							}
						}
					},
					'400': {
						description:
							'Invalid branch name, branch of a branch, demo project, or the combined id exceeds 48 characters.'
					},
					'401': UNAUTHORIZED,
					'404': { description: 'No such root project.' },
					'409': { description: 'That branch already exists.' }
				}
			}
		}
	}
};
