import {
	deployTokenSchema,
	githubConnectionPatchSchema,
	githubConnectionSchema,
	githubConnectRequestSchema,
	hostingAnalyticsSchema,
	hostingBuildEnvBundleSchema,
	hostingBuildEnvSchema,
	hostingBuildSecretRequestSchema,
	hostingClaimRequestSchema,
	hostingClaimSchema,
	hostingDeployPageSchema,
	hostingOverviewSchema,
	hostingSecretListSchema,
	hostingSecretRequestSchema,
	hostingVarListSchema,
	hostingVarsUpdateSchema,
	hostingVarsUpdatedSchema,
	mintDeployTokenSchema,
	mintedDeployTokenSchema
} from '$lib/agents';
import { jsonBody, jsonResponse, ref, UNAUTHORIZED, type AgentOpenApiModule } from './shared';

/**
 * Hosting agent module (Phase B). Every
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
		hostingVarListSchema,
		hostingVarsUpdateSchema,
		hostingVarsUpdatedSchema,
		hostingSecretListSchema,
		hostingSecretRequestSchema,
		hostingBuildEnvSchema,
		hostingBuildEnvBundleSchema,
		hostingBuildSecretRequestSchema,
		hostingAnalyticsSchema,
		deployTokenSchema,
		mintDeployTokenSchema,
		mintedDeployTokenSchema,
		githubConnectionSchema,
		githubConnectRequestSchema,
		githubConnectionPatchSchema
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
		'/hosting/apps/{app}/vars': {
			get: {
				tags: [HOSTING_TAG],
				summary: 'List runtime variables',
				description:
					'The stored plain-text variables for one app. They apply as bindings on every deploy; stored values win over the CLI-declared `meta.vars` of the same name.',
				security: [{ sessionCookie: [] }],
				parameters: [appParam],
				responses: {
					'200': jsonResponse(hostingVarListSchema, 'The variables.'),
					'401': UNAUTHORIZED
				}
			},
			put: {
				tags: [HOSTING_TAG],
				summary: 'Replace runtime variables',
				description:
					'Replaces the whole set - absent names are deleted. The store always succeeds; when the app has a live deploy the script is patched in place, reported by `patched` (false = the change applies at the next deploy).',
				security: [{ sessionCookie: [] }],
				parameters: [appParam],
				requestBody: jsonBody(hostingVarsUpdateSchema, 'The full variable set.'),
				responses: {
					'200': jsonResponse(hostingVarsUpdatedSchema, 'The stored set and patch outcome.'),
					'400': { description: 'Invalid name/value, or the 64-variable cap was exceeded.' },
					'401': UNAUTHORIZED
				}
			}
		},
		'/hosting/apps/{app}/secrets': {
			get: {
				tags: [HOSTING_TAG],
				summary: 'List secrets',
				description: 'Names and timestamps only - values are write-through and unrecoverable.',
				security: [{ sessionCookie: [] }],
				parameters: [appParam],
				responses: {
					'200': jsonResponse(hostingSecretListSchema, 'The secret names.'),
					'401': UNAUTHORIZED
				}
			},
			post: {
				tags: [HOSTING_TAG],
				summary: 'Set a secret',
				description:
					'Writes one secret through to the deployed script (`cloudflarebase secret put`). Deploys use `keep_bindings`, so redeploys never drop it. Requires a deployed app.',
				security: [{ sessionCookie: [] }],
				parameters: [appParam],
				requestBody: jsonBody(hostingSecretRequestSchema, 'The secret.'),
				responses: {
					'200': { description: 'Set.' },
					'400': { description: 'Invalid body, or the 64-secret cap was exceeded.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such app (deploy first).' },
					'503': { description: 'Hosting is not configured on this install.' }
				}
			}
		},
		'/hosting/apps/{app}/secrets/{name}': {
			delete: {
				tags: [HOSTING_TAG],
				summary: 'Delete a secret',
				description: 'Removes the script binding and the name record. Idempotent.',
				security: [{ sessionCookie: [] }],
				parameters: [
					appParam,
					{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }
				],
				responses: {
					'200': { description: 'Deleted (or was already gone).' },
					'401': UNAUTHORIZED,
					'502': { description: 'Cloudflare refused the deletion; the secret is still set.' }
				}
			}
		},
		'/hosting/apps/{app}/analytics': {
			get: {
				tags: [HOSTING_TAG],
				summary: 'App request analytics',
				description:
					'Daily requests and 5xx errors for one app, from Analytics Engine. Degrades honestly: `engine.status` reports connected/local/write-only/error and the route never 5xxes on a query failure.',
				security: [{ sessionCookie: [] }],
				parameters: [
					appParam,
					{ name: 'days', in: 'query', schema: { type: 'integer', enum: [7, 30, 90] } }
				],
				responses: {
					'200': jsonResponse(hostingAnalyticsSchema, 'The series and totals.'),
					'401': UNAUTHORIZED,
					'404': { description: 'No such app (deploy first).' }
				}
			}
		},
		'/hosting/apps/{app}/build-env': {
			get: {
				tags: [HOSTING_TAG],
				summary: 'Read the build-time environment',
				description:
					'Two personas. An operator session gets `HostingBuildEnv`: vars with values, secret NAMES only. A GitHub Actions OIDC bearer (the workflow of the connection that owns this app) gets `HostingBuildEnvBundle`: the decrypted values it exports before the build step. Build env is connection-scoped - branch builds read the root project.',
				security: [{ sessionCookie: [] }, { bearerAuth: [] }],
				parameters: [appParam],
				responses: {
					'200': {
						description: 'The environment, shaped by the caller (see description).',
						content: {
							'application/json': {
								schema: {
									oneOf: [ref(hostingBuildEnvSchema), ref(hostingBuildEnvBundleSchema)]
								}
							}
						}
					},
					'401': UNAUTHORIZED,
					'503': {
						description: 'Build secrets exist but HOSTING_MASTER_KEY is not set on this install.'
					}
				}
			}
		},
		'/hosting/apps/{app}/build-vars': {
			put: {
				tags: [HOSTING_TAG],
				summary: 'Replace build-time variables',
				description:
					'Replaces the whole set - absent names are deleted. Exported into the build environment by the connected workflow.',
				security: [{ sessionCookie: [] }],
				parameters: [appParam],
				requestBody: jsonBody(hostingVarsUpdateSchema, 'The full variable set.'),
				responses: {
					'200': jsonResponse(hostingVarListSchema, 'The stored set.'),
					'400': { description: 'Invalid name/value, or the 64-variable cap was exceeded.' },
					'401': UNAUTHORIZED
				}
			}
		},
		'/hosting/apps/{app}/build-secrets/{name}': {
			put: {
				tags: [HOSTING_TAG],
				summary: 'Set a build secret',
				description:
					"Encrypted at rest (AES-256-GCM) under the install's master key. Write-only on this surface: the console never reads a value back, and the runner's copy travels the OIDC build-env route.",
				security: [{ sessionCookie: [] }],
				parameters: [
					appParam,
					{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }
				],
				requestBody: jsonBody(hostingBuildSecretRequestSchema, 'The secret value.'),
				responses: {
					'200': { description: 'Set.' },
					'400': { description: 'Invalid name/value, or the 32-secret cap was exceeded.' },
					'401': UNAUTHORIZED,
					'503': { description: 'HOSTING_MASTER_KEY is not set on this install.' }
				}
			},
			delete: {
				tags: [HOSTING_TAG],
				summary: 'Delete a build secret',
				security: [{ sessionCookie: [] }],
				parameters: [
					appParam,
					{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }
				],
				responses: {
					'200': { description: 'Deleted (or was already gone).' },
					'401': UNAUTHORIZED
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
		},
		'/hosting/github': {
			get: {
				tags: [HOSTING_TAG],
				summary: 'GitHub push-to-deploy state',
				description:
					'Whether a GitHub App is configured on this console, the installations visible to this organization, and the repository connections.',
				security: [{ sessionCookie: [] }],
				responses: {
					'200': {
						description: 'The state.',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										configured: { type: 'boolean' },
										installations: {
											type: 'array',
											items: {
												type: 'object',
												properties: {
													id: { type: 'integer' },
													accountLogin: { type: 'string' }
												},
												required: ['id', 'accountLogin']
											}
										},
										connections: {
											type: 'array',
											items: { $ref: '#/components/schemas/GithubConnection' }
										}
									},
									required: ['configured', 'installations', 'connections']
								}
							}
						}
					},
					'401': UNAUTHORIZED
				}
			}
		},
		'/hosting/github/connections': {
			post: {
				tags: [HOSTING_TAG],
				summary: 'Connect a repository',
				description:
					'Connects a repository to this project+app (root projects only). `build` mode commits a deploy workflow into the repository and trusts its Actions OIDC token; `direct` mode deploys the pushed tree from the webhook with no file in the repository. Claims the subdomain first.',
				security: [{ sessionCookie: [] }],
				requestBody: jsonBody(githubConnectRequestSchema, 'The repository and its settings.'),
				responses: {
					'201': {
						description: 'Connected; the body carries the connection and the claimed subdomain.'
					},
					'400': { description: 'Invalid request, or the project is a branch.' },
					'401': UNAUTHORIZED,
					'403': { description: 'The installation belongs to another organization.' },
					'404': { description: 'The repository is not in this installation.' },
					'503': { description: 'No GitHub App is configured on this console.' }
				}
			}
		},
		'/hosting/github/connections/{app}': {
			patch: {
				tags: [HOSTING_TAG],
				summary: 'Edit build settings',
				description:
					'Edits a connection at any time: build command, root directory, output directory, production branch, ignored branches. On a build-mode connection the workflow file is rewritten in the repository FIRST - a failed commit changes nothing.',
				security: [{ sessionCookie: [] }],
				parameters: [appParam],
				requestBody: jsonBody(githubConnectionPatchSchema, 'The fields to change.'),
				responses: {
					'200': {
						description: 'Updated.',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										connection: { $ref: '#/components/schemas/GithubConnection' },
										workflowRewritten: { type: 'boolean' }
									},
									required: ['connection', 'workflowRewritten']
								}
							}
						}
					},
					'400': {
						description:
							'Invalid value, build fields on a direct connection, or the production branch would be ignored.'
					},
					'401': UNAUTHORIZED,
					'404': { description: 'No such connection.' },
					'503': { description: 'No GitHub App is configured on this console.' }
				}
			},
			delete: {
				tags: [HOSTING_TAG],
				summary: 'Disconnect a repository',
				description: 'Deletes the connection; the committed workflow file is removed best-effort.',
				security: [{ sessionCookie: [] }],
				parameters: [appParam],
				responses: {
					'200': { description: 'Disconnected.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such connection.' }
				}
			}
		}
	}
};
