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
	dbReplicaSchema,
	dbReplicationStatusSchema,
	dbRestorePointSchema,
	dbRestorePointsSchema,
	dbRestoreRequestSchema,
	dbRestoreResultSchema,
	dbServerFrameSchema,
	dbSubscribeFrameSchema,
	dbTableColumnSchema,
	dbTableConfigSchema,
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
const tableParam = {
	name: 'table',
	in: 'path',
	required: true,
	schema: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' },
	description:
		'Table name. Tables are schema-first: declare columns via the admin surface before writing.'
};
const docIdParam = { name: 'docId', in: 'path', required: true, schema: { type: 'string' } };
const rowIdParam = { name: 'rowId', in: 'path', required: true, schema: { type: 'string' } };
const PUBLIC_SECURITY = [{ bearerAuth: [] }];

export const dbOpenApi: AgentOpenApiModule = {
	tags: [
		{
			name: DB_TAG,
			description: [
				'Two data models, one database: Firestore-style JSON documents AND SQL tables with typed',
				'columns - each collection or table its own isolated Durable Object, both with live queries.',
				'',
				'Access is per collection/table: `public` needs nothing, `auth` needs a project JWT from',
				'`/auth/token`, `owner` additionally scopes every read and write to the token subject. Both can',
				'also require a permission key on the JWT (granted via auth roles); collections can enforce',
				'document rules (`DbValidator`) on public writes, tables enforce their declared column schema.',
				'',
				'**Live queries**: open a WebSocket to `/agents/db-agent/{projectId}/collections/{collection}/subscribe`',
				'(or `/tables/{table}/subscribe`) and send a `DbSubscribeFrame`; the server answers with a',
				'`DbServerFrame` snapshot in query order, then pushes added/modified/removed deltas as writes happen.',
				'',
				'**Tables are schema-first**: declare typed columns (`DbTableConfig`) before writing; rows share',
				'the document envelope with `data` as the column map. The physical storage uses real columns',
				'(`id`, `owner`, `created_at`, `updated_at` + yours), so ORM-generated SQL matches it.',
				'',
				'**Aggregations**: `POST /collections/{collection}/aggregate` computes count/sum/avg server-side.',
				'',
				'**Backup**: `GET /collections/{collection}/export` and `GET /tables/{table}/export` stream',
				'NDJSON; operators can also export, import, and roll either kind back to any point in the past',
				'30 days from the admin surface.'
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
		dbTableColumnSchema,
		dbTableConfigSchema,
		dbAggregateRequestSchema,
		dbAggregateResultSchema,
		dbImportReportSchema,
		dbRestoreRequestSchema,
		dbRestoreResultSchema,
		dbRestorePointSchema,
		dbRestorePointsSchema,
		dbReplicaSchema,
		dbReplicationStatusSchema,
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
		'/db/tables/{table}/rows': {
			post: {
				tags: [DB_TAG],
				summary: 'Insert a row',
				parameters: [tableParam],
				security: PUBLIC_SECURITY,
				requestBody: jsonBody(
					dbCreateRequestSchema,
					'Row data (the column map) with an optional id. Missing columns take their defaults.'
				),
				responses: {
					'201': jsonResponse(dbDocumentSchema, 'The inserted row (data = column map).'),
					'400': { description: 'The row failed the declared schema (issues array).' },
					'401': { description: 'The table requires a project token.' },
					'404': { description: 'No such table - tables are schema-first.' },
					'409': { description: 'Duplicate id or unique-column value.' },
					'429': { description: 'A demo table reached its row ceiling.' }
				}
			}
		},
		'/db/tables/{table}/rows/{rowId}': {
			get: {
				tags: [DB_TAG],
				summary: 'Read a row',
				parameters: [tableParam, rowIdParam],
				security: PUBLIC_SECURITY,
				responses: {
					'200': jsonResponse(dbDocumentSchema, 'The row.'),
					'404': { description: 'No such row (or not yours, in owner mode).' }
				}
			},
			put: {
				tags: [DB_TAG],
				summary: 'Replace a row',
				parameters: [tableParam, rowIdParam],
				security: PUBLIC_SECURITY,
				requestBody: jsonBody(dbWriteRequestSchema, 'The full replacement column map.'),
				responses: {
					'200': jsonResponse(dbDocumentSchema, 'The updated row.'),
					'400': { description: 'The row failed the declared schema.' },
					'404': { description: 'No such row.' },
					'409': { description: 'Unique-column conflict.' }
				}
			},
			patch: {
				tags: [DB_TAG],
				summary: 'Update columns of a row',
				parameters: [tableParam, rowIdParam],
				security: PUBLIC_SECURITY,
				requestBody: jsonBody(dbWriteRequestSchema, 'Columns to set; the rest keep their values.'),
				responses: {
					'200': jsonResponse(dbDocumentSchema, 'The updated row.'),
					'400': { description: 'The merged row failed the declared schema.' },
					'404': { description: 'No such row.' },
					'409': { description: 'Unique-column conflict.' }
				}
			},
			delete: {
				tags: [DB_TAG],
				summary: 'Delete a row',
				parameters: [tableParam, rowIdParam],
				security: PUBLIC_SECURITY,
				responses: {
					'200': { description: 'Deleted.' },
					'404': { description: 'No such row.' }
				}
			}
		},
		'/db/tables/{table}/query': {
			post: {
				tags: [DB_TAG],
				summary: 'Run a filtered query over typed columns',
				description:
					'The same query DSL as collections, compiled against declared columns. Dotted field paths reach into `json` columns.',
				parameters: [tableParam],
				security: PUBLIC_SECURITY,
				requestBody: jsonBody(dbQuerySchema, 'The query.'),
				responses: {
					'200': jsonResponse(dbQueryResultSchema, 'Matching rows in query order.'),
					'400': { description: 'Invalid query, unknown column, or illegal dotted path.' }
				}
			}
		},
		'/db/tables/{table}/aggregate': {
			post: {
				tags: [DB_TAG],
				summary: 'count/sum/avg over typed columns',
				parameters: [tableParam],
				security: PUBLIC_SECURITY,
				requestBody: jsonBody(dbAggregateRequestSchema, 'Aggregates keyed by result alias.'),
				responses: {
					'200': jsonResponse(dbAggregateResultSchema, 'Aggregate values by alias.'),
					'400': { description: 'Unknown column or non-numeric sum/avg target.' },
					'401': { description: 'The table requires a project token.' }
				}
			}
		},
		'/db/tables/{table}/sql': {
			post: {
				tags: [DB_TAG],
				summary: 'Run single-table SQL (ORM-grade, D1-shaped)',
				description:
					'One SELECT/INSERT/UPDATE/DELETE (or an atomic `batch`) over this table alone - what `@cloudflarebase/db/drizzle` drives. DML gains automatic RETURNING and feeds the change log and live queries. ALWAYS requires a project JWT (public modes never open raw SQL); owner-scoped tables refuse it. Results carry objects plus `raw` value arrays with `columns` order for drivers. SELECTs serve from region replicas when replication is on.',
				parameters: [tableParam],
				security: PUBLIC_SECURITY,
				requestBody: {
					description: '`{ sql, params? }` or `{ batch: [{ sql, params? }, ...] }`.',
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									sql: { type: 'string' },
									params: { type: 'array', items: {} },
									batch: {
										type: 'array',
										items: {
											type: 'object',
											required: ['sql'],
											properties: { sql: { type: 'string' }, params: { type: 'array', items: {} } }
										}
									}
								}
							}
						}
					}
				},
				responses: {
					'200': {
						description:
							'`{ success, result }` (or `batch: [...]`), each with `results`, `columns`, `raw`, and D1-style `meta`.'
					},
					'400': {
						description: 'Statement refused by the gate, or a SQL error (batches roll back whole).'
					},
					'401': { description: 'Raw SQL requires a project token.' },
					'403': { description: 'Owner-scoped table, or missing permission key.' }
				}
			}
		},
		'/db/tables/{table}/export': {
			get: {
				tags: [DB_TAG],
				summary: 'Export rows as NDJSON',
				description:
					'Streams every readable row (owner mode: only yours) in id order, one JSON row per line.',
				parameters: [tableParam],
				security: PUBLIC_SECURITY,
				responses: {
					'200': { description: 'An application/x-ndjson stream of row lines.' },
					'401': { description: 'The table requires a project token.' }
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
		'/db/admin/replication/{name}': {
			get: {
				tags: [DB_TAG],
				summary: 'Replication status for one shard',
				description:
					'Replication defaults to auto: reads route to per-region replicas, writes answer with a `cfb-lsn` session bookmark, and sending it back as `cfb-min-lsn` guarantees read-your-writes. Replicas materialize in a region the first time it reads, so an empty list on an enabled shard just means no region has read yet.',
				security: [{ sessionCookie: [] }],
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				responses: {
					'200': jsonResponse(dbReplicationStatusSchema, 'Change-log head and replica map.'),
					'401': UNAUTHORIZED,
					'404': { description: 'No such collection or table.' }
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
		'/db/admin/tables/{name}': {
			put: {
				tags: [DB_TAG],
				summary: 'Declare or alter a table',
				description:
					'The full desired schema in. Additive changes (new columns, index toggles) apply as DDL; destructive changes are refused with 400. Uniquifying a column holding duplicate data fails with 409.',
				security: [{ sessionCookie: [] }],
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				requestBody: jsonBody(dbTableConfigSchema, 'Access modes and the declared columns.'),
				responses: {
					'200': { description: 'Table declared or altered.' },
					'400': { description: 'Invalid or destructive schema change.' },
					'401': UNAUTHORIZED,
					'409': { description: 'Name in use by a collection, or the DDL failed.' },
					'429': { description: 'Shard cap reached (collections + tables share the pool).' }
				}
			},
			delete: {
				tags: [DB_TAG],
				summary: 'Delete a table and every row in it',
				security: [{ sessionCookie: [] }],
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				responses: {
					'200': { description: 'Table erased.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such table.' }
				}
			}
		},
		'/db/admin/tables/{name}/rows/{rowId}': {
			put: {
				tags: [DB_TAG],
				summary: 'Operator row upsert',
				description:
					'Structure (types, NOT NULL) always validates; policy rules (bounds, enum) are bypassed like document validators. `?ifAbsent=1` refuses taken ids with 409.',
				security: [{ sessionCookie: [] }],
				parameters: [
					{ name: 'name', in: 'path', required: true, schema: { type: 'string' } },
					{ name: 'rowId', in: 'path', required: true, schema: { type: 'string' } }
				],
				requestBody: jsonBody(dbWriteRequestSchema, 'The row data, wrapped as { data }.'),
				responses: {
					'200': jsonResponse(dbDocumentSchema, 'The written row.'),
					'400': { description: 'The row failed the declared schema.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such table.' },
					'409': { description: 'Id or unique-column conflict.' }
				}
			},
			delete: {
				tags: [DB_TAG],
				summary: 'Operator row delete',
				security: [{ sessionCookie: [] }],
				parameters: [
					{ name: 'name', in: 'path', required: true, schema: { type: 'string' } },
					{ name: 'rowId', in: 'path', required: true, schema: { type: 'string' } }
				],
				responses: {
					'200': { description: 'Deleted.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such table or row.' }
				}
			}
		},
		'/db/admin/tables/{name}/export': {
			get: {
				tags: [DB_TAG],
				summary: 'Operator NDJSON export (table)',
				description: 'Streams every row regardless of access modes.',
				security: [{ sessionCookie: [] }],
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				responses: {
					'200': { description: 'An application/x-ndjson stream of row lines.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such table.' }
				}
			}
		},
		'/db/admin/tables/{name}/import': {
			post: {
				tags: [DB_TAG],
				summary: 'Operator NDJSON import (table)',
				description:
					'Upserts one row per NDJSON line (up to 1000 per request); exported lines round-trip with id, owner, and timestamps preserved. Structure (types, NOT NULL) always validates; policy bounds do not apply - this is an operator surface.',
				security: [{ sessionCookie: [] }],
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				requestBody: {
					description: 'application/x-ndjson row lines.',
					required: true,
					content: { 'application/x-ndjson': { schema: { type: 'string' } } }
				},
				responses: {
					'200': jsonResponse(dbImportReportSchema, 'What landed and what failed, per line.'),
					'400': { description: 'No lines, or over the per-request row cap.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such table.' },
					'413': { description: 'Import body over the byte cap.' }
				}
			}
		},
		'/db/admin/tables/{name}/restore': {
			post: {
				tags: [DB_TAG],
				summary: 'Roll the table back in time',
				description:
					'Point-in-time recovery over Durable Object SQLite bookmarks (30-day window) - the collection contract on tables. Unavailable in local development (501).',
				security: [{ sessionCookie: [] }],
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				requestBody: jsonBody(dbRestoreRequestSchema, 'A timestamp or an exact bookmark.'),
				responses: {
					'200': jsonResponse(dbRestoreResultSchema, 'Restored; keep the undo bookmark.'),
					'400': { description: 'Invalid request, or the platform refused the restore.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such table.' },
					'501': { description: 'This environment has no point-in-time recovery.' }
				}
			}
		},
		'/db/admin/tables/{name}/restore-points': {
			get: {
				tags: [DB_TAG],
				summary: 'List captured restore points (table)',
				security: [{ sessionCookie: [] }],
				parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
				responses: {
					'200': jsonResponse(dbRestorePointsSchema, 'Support flag and captured points.'),
					'401': UNAUTHORIZED,
					'404': { description: 'No such table.' }
				}
			}
		},
		'/db/admin/tables/{name}/checkpoint': {
			post: {
				tags: [DB_TAG],
				summary: 'Capture a restore point now (table)',
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
					'404': { description: 'No such table.' },
					'501': { description: 'This environment has no point-in-time recovery.' }
				}
			}
		},
		'/db/admin/tables/{name}/bookmark': {
			get: {
				tags: [DB_TAG],
				summary: 'Resolve a time to its closest bookmark (table)',
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
					'404': { description: 'No such table.' },
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
				summary: 'Operator query over any collection or table',
				description:
					'Drives the dashboard browser; bypasses access modes. Name exactly one of `collection` or `table`.',
				security: [{ sessionCookie: [] }],
				requestBody: {
					description: 'The collection or table, and the query.',
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									collection: { type: 'string' },
									table: { type: 'string' },
									query: { $ref: '#/components/schemas/DbQuery' }
								}
							}
						}
					}
				},
				responses: {
					'200': jsonResponse(dbQueryResultSchema, 'Matching documents or rows.'),
					'400': { description: 'Neither or both names, or a table compile refusal.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such collection or table.' }
				}
			}
		}
	}
};
