import {
	dbCollectionConfigSchema,
	dbCreateRequestSchema,
	dbDocumentSchema,
	dbOverviewSchema,
	dbQueryResultSchema,
	dbQuerySchema,
	dbServerFrameSchema,
	dbSubscribeFrameSchema,
	dbWriteRequestSchema
} from '$lib/agents';
import { jsonBody, jsonResponse, UNAUTHORIZED, type AgentOpenApiModule } from './shared';

/** The db agent's contribution to the per-project OpenAPI document. */

const DB_TAG = 'Database';

const collectionParam = {
	name: 'collection',
	in: 'path',
	required: true,
	schema: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' },
	description:
		'Collection name. Unknown collections auto-create with `auth`/`auth` modes on first use.'
};
const docIdParam = { name: 'docId', in: 'path', required: true, schema: { type: 'string' } };
const PUBLIC_SECURITY = [{ bearerAuth: [] }];

export const dbOpenApi: AgentOpenApiModule = {
	tags: [
		{
			name: DB_TAG,
			description: [
				'Firestore-style JSON documents with live queries, one isolated Durable Object per collection.',
				'',
				'Access is per collection: `public` needs nothing, `auth` needs a project JWT from `/auth/token`,',
				'`owner` additionally scopes every read and write to the token subject.',
				'',
				'**Live queries**: open a WebSocket to `/agents/db-agent/{projectId}/collections/{collection}/subscribe`',
				'and send a `DbSubscribeFrame`; the server answers with a `DbServerFrame` snapshot in query order,',
				'then pushes added/modified/removed deltas as writes happen (see those schemas below).'
			].join('\n')
		}
	],
	schemas: [
		dbQuerySchema,
		dbDocumentSchema,
		dbQueryResultSchema,
		dbCreateRequestSchema,
		dbWriteRequestSchema,
		dbCollectionConfigSchema,
		dbOverviewSchema,
		dbSubscribeFrameSchema,
		dbServerFrameSchema
	],
	paths: {
		'/db/collections/{collection}/documents': {
			post: {
				tags: [DB_TAG],
				summary: 'Create a document',
				parameters: [collectionParam],
				security: PUBLIC_SECURITY,
				requestBody: jsonBody(dbCreateRequestSchema, 'Document data with an optional id.'),
				responses: {
					'201': jsonResponse(dbDocumentSchema, 'The created document.'),
					'401': { description: 'The collection requires a project token.' },
					'409': { description: 'A document with that id already exists.' },
					'413': { description: 'Document data over the size cap.' },
					'429': { description: 'A demo collection reached its document ceiling.' }
				}
			}
		},
		'/db/collections/{collection}/documents/{docId}': {
			get: {
				tags: [DB_TAG],
				summary: 'Read a document',
				parameters: [collectionParam, docIdParam],
				security: PUBLIC_SECURITY,
				responses: {
					'200': jsonResponse(dbDocumentSchema, 'The document.'),
					'404': { description: 'No such document (or not yours, in owner mode).' }
				}
			},
			put: {
				tags: [DB_TAG],
				summary: 'Replace document data',
				parameters: [collectionParam, docIdParam],
				security: PUBLIC_SECURITY,
				requestBody: jsonBody(dbWriteRequestSchema, 'The full replacement data.'),
				responses: {
					'200': jsonResponse(dbDocumentSchema, 'The updated document.'),
					'404': { description: 'No such document.' }
				}
			},
			patch: {
				tags: [DB_TAG],
				summary: 'Merge into document data',
				parameters: [collectionParam, docIdParam],
				security: PUBLIC_SECURITY,
				requestBody: jsonBody(dbWriteRequestSchema, 'Fields to shallow-merge.'),
				responses: {
					'200': jsonResponse(dbDocumentSchema, 'The updated document.'),
					'404': { description: 'No such document.' }
				}
			},
			delete: {
				tags: [DB_TAG],
				summary: 'Delete a document',
				parameters: [collectionParam, docIdParam],
				security: PUBLIC_SECURITY,
				responses: {
					'200': { description: 'Deleted.' },
					'404': { description: 'No such document.' }
				}
			}
		},
		'/db/collections/{collection}/query': {
			post: {
				tags: [DB_TAG],
				summary: 'Run a filtered query',
				parameters: [collectionParam],
				security: PUBLIC_SECURITY,
				requestBody: jsonBody(dbQuerySchema, 'The query.'),
				responses: {
					'200': jsonResponse(dbQueryResultSchema, 'Matching documents in query order.'),
					'400': { description: 'Invalid query.' }
				}
			}
		},
		'/db/overview': {
			get: {
				tags: [DB_TAG],
				summary: 'Collections, counts, and live state',
				security: [{ sessionCookie: [] }],
				responses: {
					'200': jsonResponse(dbOverviewSchema, 'The project database overview.'),
					'401': UNAUTHORIZED
				}
			}
		},
		'/db/admin/collections/{name}': {
			put: {
				tags: [DB_TAG],
				summary: 'Create or configure a collection',
				security: [{ sessionCookie: [] }],
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				requestBody: jsonBody(dbCollectionConfigSchema, 'Read/write access modes.'),
				responses: {
					'200': { description: 'Collection configured.' },
					'401': UNAUTHORIZED,
					'429': { description: 'Collection cap reached.' }
				}
			},
			delete: {
				tags: [DB_TAG],
				summary: 'Delete a collection and every document in it',
				security: [{ sessionCookie: [] }],
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				responses: {
					'200': { description: 'Collection erased.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such collection.' }
				}
			}
		},
		'/db/admin/query': {
			post: {
				tags: [DB_TAG],
				summary: 'Operator query over any collection',
				description: 'Drives the dashboard browser; bypasses access modes.',
				security: [{ sessionCookie: [] }],
				requestBody: {
					description: 'The collection and query.',
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['collection'],
								properties: {
									collection: { type: 'string' },
									query: { $ref: '#/components/schemas/DbQuery' }
								}
							}
						}
					}
				},
				responses: {
					'200': jsonResponse(dbQueryResultSchema, 'Matching documents.'),
					'401': UNAUTHORIZED,
					'404': { description: 'No such collection.' }
				}
			}
		}
	}
};
