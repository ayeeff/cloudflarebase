import {
	deployTokenSchema,
	hostingClaimRequestSchema,
	hostingClaimSchema,
	hostingDeployPageSchema,
	hostingOverviewSchema,
	mintDeployTokenSchema,
	mintedDeployTokenSchema
} from '$lib/agents';
import { jsonBody, jsonResponse, UNAUTHORIZED, type AgentOpenApiModule } from './shared';

/**
 * Hosting agent module (docs/managed-service-design.md, Phase B). Every
 * endpoint here is operator-plane: apps are deployed BY the project owner,
 * not called by their application, so nothing is public. Claims and deploy
 * tokens are console-plane (control-plane D1) but documented under the same
 * tag - to an operator they are one Hosting surface.
 */

const HOSTING_TAG = 'Hosting';

const appParam = {
	name: 'app',
	in: 'path',
	required: true,
	description: 'The app name (not the subdomain - taken names auto-number).',
	schema: { type: 'string' }
};

export const hostingOpenApi: AgentOpenApiModule = {
	tags: [
		{
			name: HOSTING_TAG,
			description: [
				'Apps and functions on Workers for Platforms: static assets and server',
				'code in one deploy, served at `<app>.cfbase.dev` (root project) or',
				'`<app>-<branch>.cfbase.dev` (branch). Deploys ride an operator session',
				'or a project-scoped deploy token (`cfbd_...` bearer), which is also',
				'accepted on `POST /branches` so CI can create preview branches.'
			].join('\n')
		}
	],
	schemas: [
		hostingOverviewSchema,
		hostingDeployPageSchema,
		hostingClaimSchema,
		hostingClaimRequestSchema,
		deployTokenSchema,
		mintDeployTokenSchema,
		mintedDeployTokenSchema
	],
	paths: {
		'/hosting/overview': {
			get: {
				tags: [HOSTING_TAG],
				summary: 'Hosting overview',
				description: 'Apps, recent deploys, and whether this install can complete real deploys.',
				security: [{ sessionCookie: [] }],
				responses: {
					'200': jsonResponse(hostingOverviewSchema, 'The overview.'),
					'401': UNAUTHORIZED
				}
			}
		},
		'/hosting/deploys': {
			get: {
				tags: [HOSTING_TAG],
				summary: 'List deploys',
				description: 'Keyset-paged deploy history, newest first. Filter with `?app=<name>`.',
				security: [{ sessionCookie: [] }],
				parameters: [
					{ name: 'app', in: 'query', schema: { type: 'string' } },
					{ name: 'cursor', in: 'query', schema: { type: 'string' } },
					{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } }
				],
				responses: {
					'200': jsonResponse(hostingDeployPageSchema, 'One page of deploys.'),
					'401': UNAUTHORIZED
				}
			}
		},
		'/hosting/claims': {
			post: {
				tags: [HOSTING_TAG],
				summary: 'Claim a subdomain',
				description:
					'Resolves the subdomain for this project+app: the persisted claim wins; otherwise the wanted name (`<app>` on the root, `<app>-<branch>` on a branch) auto-numbers past collisions - it never fails on a taken name. `dry: true` previews without claiming.',
				security: [{ sessionCookie: [] }],
				requestBody: jsonBody(hostingClaimRequestSchema, 'The app to claim for.'),
				responses: {
					'200': jsonResponse(hostingClaimSchema, 'Existing claim reused (or dry run).'),
					'201': jsonResponse(hostingClaimSchema, 'Subdomain claimed.'),
					'400': { description: 'Invalid app name.' },
					'401': UNAUTHORIZED,
					'403': { description: 'Demo projects cannot deploy apps.' },
					'409': { description: 'App limit reached.' }
				}
			}
		},
		'/hosting/apps/{app}/deploys': {
			post: {
				tags: [HOSTING_TAG],
				summary: 'Deploy an app',
				description:
					'Multipart deploy: a `meta` JSON part plus `module:<name>` and `asset:<path>` file parts. The console resolves the subdomain claim, then the agent runs the Workers for Platforms upload. Accepts an operator session or a deploy token. The response reports the subdomain that was ACTUALLY claimed.',
				security: [{ sessionCookie: [] }, { bearerAuth: [] }],
				parameters: [appParam],
				responses: {
					'201': { description: 'Deployed; the body carries the deploy, subdomain, and URL.' },
					'400': { description: 'Invalid deploy payload or a cap was exceeded.' },
					'401': UNAUTHORIZED,
					'403': { description: 'Demo projects cannot deploy apps.' },
					'429': { description: 'Daily deploy limit reached.' },
					'503': { description: 'Hosting is not configured on this install.' }
				}
			}
		},
		'/hosting/tokens': {
			get: {
				tags: [HOSTING_TAG],
				summary: 'List deploy tokens',
				description: 'Metadata only - secrets are stored as SHA-256 digests and unrecoverable.',
				security: [{ sessionCookie: [] }],
				responses: {
					'200': {
						description: 'The tokens.',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										tokens: { type: 'array', items: { $ref: '#/components/schemas/DeployToken' } }
									},
									required: ['tokens']
								}
							}
						}
					},
					'401': UNAUTHORIZED
				}
			},
			post: {
				tags: [HOSTING_TAG],
				summary: 'Mint a deploy token',
				description:
					'Root projects only; the token covers the root and all its branches. The secret appears exactly once in this response.',
				security: [{ sessionCookie: [] }],
				requestBody: jsonBody(mintDeployTokenSchema, 'A label for the token.'),
				responses: {
					'201': jsonResponse(mintedDeployTokenSchema, 'The minted token.'),
					'400': { description: 'Invalid name, or the project is a branch.' },
					'401': UNAUTHORIZED,
					'409': { description: 'Token limit reached.' }
				}
			}
		},
		'/hosting/tokens/{tokenId}': {
			delete: {
				tags: [HOSTING_TAG],
				summary: 'Revoke a deploy token',
				security: [{ sessionCookie: [] }],
				parameters: [{ name: 'tokenId', in: 'path', required: true, schema: { type: 'string' } }],
				responses: {
					'200': { description: 'Revoked.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such token.' }
				}
			}
		}
	}
};
