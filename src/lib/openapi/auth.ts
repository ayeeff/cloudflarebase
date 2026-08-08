import {
	agentChatReplySchema,
	authAgentStateSchema,
	authAnalyticsSchema,
	authOverviewSchema,
	overviewSessionSchema,
	overviewUserSchema,
	roleDefinitionSchema,
	sessionPageSchema,
	userPageSchema
} from '$lib/agents';
import {
	chatRequestSchema,
	roleUpdateSchema,
	rolesUpdateSchema,
	settingsPayloadSchema,
	signInSchema,
	signUpSchema
} from '$lib/schemas/auth';
import { jsonBody, jsonResponse, UNAUTHORIZED, type AgentOpenApiModule } from './shared';

/** The auth agent's contribution to the per-project OpenAPI document. */

const AUTH_TAG = 'Authentication';
const CONSOLE_TAG = 'Console';

const PAGE_CURSOR = {
	name: 'cursor',
	in: 'query',
	required: false,
	schema: { type: 'string' },
	description: "Opaque continuation from the previous page's `nextCursor`."
};
const PAGE_LIMIT = {
	name: 'limit',
	in: 'query',
	required: false,
	schema: { type: 'integer', minimum: 1, maximum: 200 },
	description: 'Rows per page. Defaults to 50, capped at 200.'
};

export const authOpenApi: AgentOpenApiModule = {
	tags: [
		{ name: AUTH_TAG, description: 'Public endpoints your application calls.' },
		{ name: CONSOLE_TAG, description: 'Operator endpoints for managing the project.' }
	],
	schemas: [
		signUpSchema,
		signInSchema,
		chatRequestSchema,
		settingsPayloadSchema,
		rolesUpdateSchema,
		roleUpdateSchema,
		authOverviewSchema,
		authAnalyticsSchema,
		authAgentStateSchema,
		overviewUserSchema,
		overviewSessionSchema,
		userPageSchema,
		sessionPageSchema,
		roleDefinitionSchema,
		agentChatReplySchema
	],
	paths: {
		'/auth/sign-up/email': {
			post: {
				tags: [AUTH_TAG],
				summary: 'Create an account',
				description:
					'Signs the new user in and returns a session. External clients should read the `set-auth-token` response header.',
				requestBody: jsonBody(signUpSchema, 'The account to create.'),
				responses: {
					'200': { description: 'Account created and signed in.' },
					'422': { description: 'Validation failed, or the email is already registered.' },
					'429': { description: 'Rate limited, or a demo project reached its user ceiling.' }
				}
			}
		},
		'/auth/sign-in/email': {
			post: {
				tags: [AUTH_TAG],
				summary: 'Sign in',
				requestBody: jsonBody(signInSchema, 'Credentials.'),
				responses: {
					'200': { description: 'Signed in.' },
					'401': { description: 'Incorrect email or password.' },
					'429': { description: 'Rate limited.' }
				}
			}
		},
		'/auth/sign-in/anonymous': {
			post: {
				tags: [AUTH_TAG],
				summary: 'Sign in as a guest',
				description:
					'Creates a throwaway identity with no credentials. Guests can hold roles and can be upgraded later.',
				responses: {
					'200': { description: 'Guest session created.' },
					'403': { description: 'Guest sign-in is disabled for this project.' }
				}
			}
		},
		'/auth/get-session': {
			get: {
				tags: [AUTH_TAG],
				summary: 'Read the current session',
				security: [{ bearerAuth: [] }, { sessionCookie: [] }],
				responses: {
					'200': { description: 'The session and user, or null when signed out.' }
				}
			}
		},
		'/auth/sign-out': {
			post: {
				tags: [AUTH_TAG],
				summary: 'Sign out',
				security: [{ bearerAuth: [] }, { sessionCookie: [] }],
				responses: { '200': { description: 'Session revoked.' } }
			}
		},
		'/auth/token': {
			get: {
				tags: [AUTH_TAG],
				summary: 'Issue a project-signed JWT',
				description:
					"Returns a JWT carrying `email`, `role`, and `permissions` claims, signed with this project's key. Verify it offline against `/auth/jwks`.",
				security: [{ bearerAuth: [] }, { sessionCookie: [] }],
				responses: {
					'200': { description: 'The signed token.' },
					'401': { description: 'No session.' }
				}
			}
		},
		'/auth/jwks': {
			get: {
				tags: [AUTH_TAG],
				summary: 'Public keys for this project',
				description: 'JSON Web Key Set used to verify tokens from `/auth/token`.',
				responses: { '200': { description: 'The key set.' } }
			}
		},
		'/config': {
			get: {
				tags: [AUTH_TAG],
				summary: 'Public client configuration',
				description: 'Enabled providers and capabilities. Never returns provider secrets.',
				responses: { '200': { description: 'Safe client configuration.' } }
			}
		},
		'/overview': {
			get: {
				tags: [CONSOLE_TAG],
				summary: 'Users, sessions, and live project state',
				security: [{ sessionCookie: [] }],
				responses: {
					'200': jsonResponse(authOverviewSchema, 'Current users and sessions.'),
					'401': UNAUTHORIZED
				}
			}
		},
		'/analytics': {
			get: {
				tags: [CONSOLE_TAG],
				summary: 'Operational and behavioural aggregates',
				parameters: [
					{
						name: 'timeZone',
						in: 'query',
						required: false,
						schema: { type: 'string' },
						description: 'IANA time zone used to bucket daily activity. Defaults to Etc/UTC.'
					}
				],
				security: [{ sessionCookie: [] }],
				responses: {
					'200': jsonResponse(authAnalyticsSchema, 'Aggregates for this project.'),
					'400': { description: 'Invalid time zone.' },
					'401': UNAUTHORIZED
				}
			}
		},
		'/chat': {
			post: {
				tags: [CONSOLE_TAG],
				summary: 'Ask the project agent a question',
				description:
					"Workers AI answer grounded in this project's live auth and database data via a console-side tool loop.",
				security: [{ sessionCookie: [] }],
				requestBody: jsonBody(chatRequestSchema, 'The question.'),
				responses: {
					'200': jsonResponse(agentChatReplySchema, 'The answer and the stored message pair.'),
					'401': UNAUTHORIZED,
					'429': { description: 'A demo project reached its daily inference ceiling.' },
					'502': { description: 'Inference failed. Auth and analytics are unaffected.' }
				}
			}
		},
		'/admin/settings': {
			put: {
				tags: [CONSOLE_TAG],
				summary: 'Update trusted origins and social credentials',
				security: [{ sessionCookie: [] }],
				requestBody: jsonBody(settingsPayloadSchema, 'Settings to apply.'),
				responses: {
					'200': { description: 'Settings applied.' },
					'400': { description: 'Validation failed.' },
					'401': UNAUTHORIZED
				}
			}
		},
		'/admin/roles': {
			put: {
				tags: [CONSOLE_TAG],
				summary: 'Replace the role registry',
				description: 'The built-in `user` and `admin` roles always remain.',
				security: [{ sessionCookie: [] }],
				requestBody: jsonBody(rolesUpdateSchema, 'The complete role registry.'),
				responses: {
					'200': { description: 'Registry replaced.' },
					'400': { description: 'Validation failed.' },
					'401': UNAUTHORIZED
				}
			}
		},
		'/admin/users': {
			get: {
				tags: [CONSOLE_TAG],
				summary: 'One page of users, newest first',
				description:
					"Keyset pagination: pass the previous response's `nextCursor` to continue. The cursor is opaque; an absent `nextCursor` means the last page. Offset paging is deliberately not offered - sign-ups landing mid-scan would skip or repeat rows.",
				security: [{ sessionCookie: [] }],
				parameters: [PAGE_CURSOR, PAGE_LIMIT],
				responses: {
					'200': jsonResponse(userPageSchema, 'One page of users.'),
					'401': UNAUTHORIZED
				}
			}
		},
		'/admin/sessions': {
			get: {
				tags: [CONSOLE_TAG],
				summary: 'One page of live sessions, newest first',
				description:
					'Keyset pagination, same contract as `/admin/users`. Expired sessions are filtered in SQL, so a full page is always live sessions.',
				security: [{ sessionCookie: [] }],
				parameters: [PAGE_CURSOR, PAGE_LIMIT],
				responses: {
					'200': jsonResponse(sessionPageSchema, 'One page of live sessions.'),
					'401': UNAUTHORIZED
				}
			}
		},
		'/admin/users/{userId}/role': {
			put: {
				tags: [CONSOLE_TAG],
				summary: "Assign a user's role",
				description: 'The only writer of `user.role`; sign-up cannot self-assign one.',
				security: [{ sessionCookie: [] }],
				parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string' } }],
				requestBody: jsonBody(roleUpdateSchema, 'The role to assign.'),
				responses: {
					'200': { description: 'Role assigned.' },
					'400': { description: 'Unknown role.' },
					'401': UNAUTHORIZED
				}
			}
		},
		'/admin/users/{userId}': {
			delete: {
				tags: [CONSOLE_TAG],
				summary: 'Delete a user',
				description: 'Removes the user and every session belonging to them.',
				security: [{ sessionCookie: [] }],
				parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string' } }],
				responses: {
					'200': { description: 'User deleted.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such user.' }
				}
			}
		},
		'/admin/sessions/{sessionId}': {
			delete: {
				tags: [CONSOLE_TAG],
				summary: 'Revoke a session',
				security: [{ sessionCookie: [] }],
				parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }],
				responses: {
					'200': { description: 'Session revoked.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such session.' }
				}
			}
		}
	}
};
