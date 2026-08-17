import {
	storageBucketConfigInputSchema,
	storageBucketSchema,
	storageBucketSummarySchema,
	storageObjectPageSchema,
	storageObjectSchema,
	storageOverviewSchema
} from '$lib/agents';
import {
	jsonBody,
	jsonResponse,
	OPERATOR_SECURITY,
	UNAUTHORIZED,
	type AgentOpenApiModule
} from './shared';

/**
 * Storage agent module (docs/storage-agent-plan.md, S1). Only the
 * operator-plane endpoints are path items: the OBJECT paths live on the
 * direct agent base (`/agents/storage-agent/<pid>/buckets/...`, because
 * bytes must not transit the JSON proxy, whose handlers buffer bodies) -
 * outside this document's server URL, so they are described in the tag text
 * rather than mis-addressed as path items.
 */

const STORAGE_TAG = 'Storage';

const bucketParam = {
	name: 'bucket',
	in: 'path',
	required: true,
	description: 'Bucket name (2-63 lowercase letters, digits, dashes).',
	schema: { type: 'string' }
};

export const storageOpenApi: AgentOpenApiModule = {
	tags: [
		{
			name: STORAGE_TAG,
			description: [
				'Object storage on R2: buckets of files with per-bucket access modes',
				'(`public` / `auth` / `owner`), verified against this project’s JWTs.',
				'',
				'**Object bytes do not travel through this API base.** Uploads,',
				'downloads, and listings live on the direct agent path (the JSON proxy',
				'buffers bodies, and 100 MB bodies must stream):',
				'',
				'- `GET|PUT|DELETE <origin>/agents/storage-agent/<projectId>/buckets/<bucket>/objects/<key>`',
				'- `GET  <origin>/agents/storage-agent/<projectId>/buckets/<bucket>/objects?prefix=&cursor=&limit=`',
				'',
				'Uploads are single-shot up to 100 MB (`Content-Length` required;',
				'multipart for larger files arrives with S2). `auth`/`owner` buckets',
				'take the project JWT as a bearer token; on `owner` buckets the',
				'writer’s subject is stamped on the object and scopes reads, deletes,',
				'and overwrites. Every object response carries',
				'`X-Content-Type-Options: nosniff`, and only raster images, audio,',
				'video, `text/plain`, and PDF render inline; everything else downloads',
				'as an attachment (HTML and SVG deliberately included - stored XSS).'
			].join('\n')
		}
	],
	schemas: [
		storageOverviewSchema,
		storageBucketSummarySchema,
		storageBucketSchema,
		storageBucketConfigInputSchema,
		storageObjectSchema,
		storageObjectPageSchema
	],
	paths: {
		'/storage/overview': {
			get: {
				tags: [STORAGE_TAG],
				summary: 'Storage overview',
				description:
					'Buckets, totals, caps, and whether this install can store bytes (the R2 binding).',
				security: OPERATOR_SECURITY,
				responses: {
					'200': jsonResponse(storageOverviewSchema, 'The overview.'),
					'401': UNAUTHORIZED
				}
			}
		},
		'/storage/admin/buckets': {
			get: {
				tags: [STORAGE_TAG],
				summary: 'List buckets',
				security: OPERATOR_SECURITY,
				responses: {
					'200': {
						description: 'The buckets.',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										buckets: {
											type: 'array',
											items: { $ref: '#/components/schemas/StorageBucketSummary' }
										}
									},
									required: ['buckets']
								}
							}
						}
					},
					'401': UNAUTHORIZED
				}
			}
		},
		'/storage/admin/buckets/{bucket}': {
			get: {
				tags: [STORAGE_TAG],
				summary: 'Get a bucket',
				security: OPERATOR_SECURITY,
				parameters: [bucketParam],
				responses: {
					'200': jsonResponse(storageBucketSchema, 'The bucket and its full config.'),
					'401': UNAUTHORIZED,
					'404': { description: 'No such bucket.' }
				}
			},
			put: {
				tags: [STORAGE_TAG],
				summary: 'Create or update a bucket',
				description:
					'Creates the bucket on first PUT (defaults: `auth` read and write, listing not public). Omitted fields keep their stored value; explicit null clears.',
				security: OPERATOR_SECURITY,
				parameters: [bucketParam],
				requestBody: jsonBody(storageBucketConfigInputSchema, 'The config to apply.'),
				responses: {
					'200': jsonResponse(storageBucketSchema, 'Updated.'),
					'201': jsonResponse(storageBucketSchema, 'Created.'),
					'400': { description: 'Invalid name or config.' },
					'401': UNAUTHORIZED,
					'403': { description: 'Demo projects have no storage.' },
					'409': { description: 'Bucket limit reached.' }
				}
			},
			delete: {
				tags: [STORAGE_TAG],
				summary: 'Delete a bucket',
				description: 'Deletes the R2 objects first, then the index, then the bucket itself.',
				security: OPERATOR_SECURITY,
				parameters: [bucketParam],
				responses: {
					'200': { description: 'Deleted.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such bucket.' }
				}
			}
		},
		'/storage/admin/buckets/{bucket}/objects': {
			get: {
				tags: [STORAGE_TAG],
				summary: 'List objects',
				description:
					'Keyset paging by key, access modes bypassed. This is the operator mirror of the public ' +
					'listing, and it ignores `publicListing`.',
				security: OPERATOR_SECURITY,
				parameters: [
					bucketParam,
					{
						name: 'prefix',
						in: 'query',
						required: false,
						schema: { type: 'string' },
						description: 'Only keys starting with this prefix.'
					},
					{
						name: 'cursor',
						in: 'query',
						required: false,
						schema: { type: 'string' },
						description: 'Continuation from the previous page.'
					},
					{
						name: 'limit',
						in: 'query',
						required: false,
						schema: { type: 'integer', minimum: 1, maximum: 200 },
						description: 'Objects per page. Defaults to 50, capped at 200.'
					}
				],
				responses: {
					'200': jsonResponse(storageObjectPageSchema, 'One page of objects.'),
					'401': UNAUTHORIZED,
					'404': { description: 'No such bucket.' }
				}
			}
		},
		'/storage/admin/buckets/{bucket}/objects/{key}': {
			get: {
				tags: [STORAGE_TAG],
				summary: 'Download an object',
				description:
					'Streams the bytes, access modes and owner checks bypassed. Range and conditional requests ' +
					'reach R2. Every response carries `X-Content-Type-Options: nosniff`, and inline rendering is ' +
					'an allowlist - HTML and SVG always download, because this path shares the console origin.',
				security: OPERATOR_SECURITY,
				parameters: [
					bucketParam,
					{
						name: 'key',
						in: 'path',
						required: true,
						description: 'Object key. Slashes are literal path segments.',
						schema: { type: 'string' }
					}
				],
				responses: {
					'200': { description: 'The object bytes.' },
					'206': { description: 'A range of the object.' },
					'304': { description: 'Not modified.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such bucket or object.' }
				}
			},
			put: {
				tags: [STORAGE_TAG],
				summary: 'Upload an object',
				description:
					'Streams the body straight to R2 - bytes never enter a Durable Object. `Content-Length` is ' +
					'REQUIRED (411 without it): a chunked body would have to be buffered, and a 100 MB buffer in ' +
					'a shared isolate is a memory bomb. Note that SvelteKit refuses form content types on ' +
					'originless writes, so a service key should send `application/octet-stream` or a real media ' +
					'type rather than `text/plain`.',
				security: OPERATOR_SECURITY,
				parameters: [
					bucketParam,
					{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }
				],
				requestBody: {
					description: 'The object bytes.',
					required: true,
					content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } }
				},
				responses: {
					'200': jsonResponse(storageObjectSchema, 'Stored.'),
					'401': UNAUTHORIZED,
					'403': { description: 'Demo projects have no storage.' },
					'411': { description: 'Content-Length is required.' },
					'413': { description: 'Object, bucket, or project ceiling exceeded.' }
				}
			},
			delete: {
				tags: [STORAGE_TAG],
				summary: 'Delete an object',
				description: 'Removes it from R2 first, then the index - a crash leaves no billed orphan.',
				security: OPERATOR_SECURITY,
				parameters: [
					bucketParam,
					{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }
				],
				responses: {
					'200': { description: 'Deleted.' },
					'401': UNAUTHORIZED,
					'404': { description: 'No such bucket or object.' }
				}
			}
		}
	}
};
