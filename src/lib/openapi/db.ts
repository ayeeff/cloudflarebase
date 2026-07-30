import {
	dbAggregateRequestSchema,
	dbAggregateResultSchema,
	dbBookmarkResolutionSchema,
	dbCollectionConfigSchema,
	dbCreateRequestSchema,
	dbDocumentSchema,
	dbFieldRuleSchema,
	dbImportReportSchema,
	dbOverviewSchema,
	dbQueryResultSchema,
	dbQuerySchema,
	dbRestorePointSchema,
	dbRestorePointsSchema,
	dbRestoreRequestSchema,
	dbRestoreResultSchema,
	dbServerFrameSchema,
	dbSubscribeFrameSchema,
	dbValidatorSchema,
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
				'`owner` additionally scopes every read and write to the token subject. Collections can also',
				'require a permission key on the JWT (granted via auth roles) and enforce document rules',
				'(`DbValidator`) on public writes.',
				'',
				'**Live queries**: open a WebSocket to `/agents/db-agent/{projectId}/collections/{collection}/subscribe`',
				'and send a `DbSubscribeFrame`; the server answers with a `DbServerFrame` snapshot in query order,',
				'then pushes added/modified/removed deltas as writes happen (see those schemas below).',
				'',
				'**Aggregations**: `POST /collections/{collection}/aggregate` computes count/sum/avg server-side.',
				'',
				'**Backup**: `GET /collections/{collection}/export` streams NDJSON; operators can also export,',
				'import, and roll a collection back to any point in the past 30 days from the admin surface.'
			].join('\n')
		}
	],
	schemas: [
		dbQuerySchema,
		dbDocumentSchema,
		dbQueryResultSchema,
		dbCreateRequestSchema,
		dbWriteRequestSchema,
		dbFieldRuleSchema,
		dbValidatorSchema,
		dbCollectionConfigSchema,
		dbAggregateRequestSchema,
		dbAggregateResultSchema,
		dbImportReportSchema,
		dbRestoreRequestSchema,
		dbRestoreResultSchema,
		dbRestorePointSchema,
		dbRestorePointsSchema,
		dbBookmarkResolutionSchema,
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
		'/db/collections/{collection}/aggregate': {
			post: {
				tags: [DB_TAG],
				summary: 'Compute count/sum/avg server-side',
				parameters: [collectionParam],
				security: PUBLIC_SECURITY,
				requestBody: jsonBody(dbAggregateRequestSchema, 'Aggregates keyed by result alias.'),
				responses: {
					'200': jsonResponse(dbAggregateResultSchema, 'Aggregate values by alias.'),
					'400': { description: 'Invalid aggregate request.' },
					'401': { description: 'The collection requires a project token.' }
				}
			}
		},
		'/db/collections/{collection}/export': {
			get: {
				tags: [DB_TAG],
				summary: 'Export documents as NDJSON',
				description:
					'Streams every readable document (owner mode: only yours) in id order, one JSON document per line.',
				parameters: [collectionParam],
				security: PUBLIC_SECURITY,
				responses: {
					'200': { description: 'An application/x-ndjson stream of DbDocument lines.' },
					'401': { description: 'The collection requires a project token.' }
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
				requestBody: jsonBody(
					dbCollectionConfigSchema,
					'Access modes, permission requirements, and document rules.'
				),
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
		'/db/admin/collections/{name}/export': {
			get: {
				tags: [DB_TAG],
				summary: 'Operator NDJSON export',
				description: 'Streams every document regardless of access modes.',
				security: [{ sessionCookie: [] }],
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				responses: {
					'200': { description: 'An application/x-ndjson stream of DbDocument lines.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such collection.' }
				}
			}
		},
		'/db/admin/collections/{name}/import': {
			post: {
				tags: [DB_TAG],
				summary: 'Operator NDJSON import',
				description:
					'Upserts one document per NDJSON line (up to 1000 per request); exported lines round-trip with id, owner, and timestamps preserved. Validator rules do not apply - this is an operator surface.',
				security: [{ sessionCookie: [] }],
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				requestBody: {
					description: 'application/x-ndjson document lines.',
					required: true,
					content: { 'application/x-ndjson': { schema: { type: 'string' } } }
				},
				responses: {
					'200': jsonResponse(dbImportReportSchema, 'What landed and what failed, per line.'),
					'400': { description: 'No lines, or over the per-request document cap.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such collection.' },
					'413': { description: 'Import body over the byte cap.' }
				}
			}
		},
		'/db/admin/collections/{name}/restore': {
			post: {
				tags: [DB_TAG],
				summary: 'Roll the collection back in time',
				description:
					'Point-in-time recovery over Durable Object SQLite bookmarks (30-day window). Live subscribers are disconnected and reconnect against the restored data; the response carries the bookmark that undoes the rollback. Unavailable in local development (501).',
				security: [{ sessionCookie: [] }],
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				requestBody: jsonBody(dbRestoreRequestSchema, 'A timestamp or an exact bookmark.'),
				responses: {
					'200': jsonResponse(dbRestoreResultSchema, 'Restored; keep the undo bookmark.'),
					'400': { description: 'Invalid request, or the platform refused the restore.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such collection.' },
					'501': { description: 'This environment has no point-in-time recovery.' }
				}
			}
		},
		'/db/admin/collections/{name}/restore-points': {
			get: {
				tags: [DB_TAG],
				summary: 'List captured restore points',
				description:
					'Named PITR markers plus whether this environment supports recovery at all. Markers are conveniences - restore-by-timestamp reaches any moment in the 30-day window.',
				security: [{ sessionCookie: [] }],
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				responses: {
					'200': jsonResponse(dbRestorePointsSchema, 'Support flag and captured points.'),
					'401': UNAUTHORIZED,
					'404': { description: 'No such collection.' }
				}
			}
		},
		'/db/admin/collections/{name}/checkpoint': {
			post: {
				tags: [DB_TAG],
				summary: 'Capture a restore point now',
				security: [{ sessionCookie: [] }],
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				requestBody: {
					description: 'Optional reason label.',
					required: false,
					content: {
						'application/json': {
							schema: { type: 'object', properties: { reason: { type: 'string', maxLength: 80 } } }
						}
					}
				},
				responses: {
					'200': jsonResponse(dbRestorePointSchema, 'The captured point.'),
					'401': UNAUTHORIZED,
					'404': { description: 'No such collection.' },
					'501': { description: 'This environment has no point-in-time recovery.' }
				}
			}
		},
		'/db/admin/collections/{name}/bookmark': {
			get: {
				tags: [DB_TAG],
				summary: 'Resolve a time to its closest bookmark',
				description: 'D1-restore-style: pass ?at=<ISO time> within the past 30 days.',
				security: [{ sessionCookie: [] }],
				parameters: [
					{ name: 'name', in: 'path', required: true, schema: { type: 'string' } },
					{
						name: 'at',
						in: 'query',
						required: true,
						schema: { type: 'string', format: 'date-time' }
					}
				],
				responses: {
					'200': jsonResponse(dbBookmarkResolutionSchema, 'The closest available bookmark.'),
					'400': { description: 'Missing/invalid ?at, or outside the 30-day window.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such collection.' },
					'501': { description: 'This environment has no point-in-time recovery.' }
				}
			}
		},
		'/db/admin/aggregate': {
			post: {
				tags: [DB_TAG],
				summary: 'Operator aggregate over any collection',
				description: 'count/sum/avg regardless of access modes.',
				security: [{ sessionCookie: [] }],
				requestBody: {
					description: 'The collection and aggregate request.',
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['collection', 'aggregate'],
								properties: {
									collection: { type: 'string' },
									aggregate: { $ref: '#/components/schemas/DbAggregateRequest' }
								}
							}
						}
					}
				},
				responses: {
					'200': jsonResponse(dbAggregateResultSchema, 'Aggregate values by alias.'),
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
