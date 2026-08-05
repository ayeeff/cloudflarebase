/**
 * Compile-time contract tests for AssertDbAgentEnv. Excluded from the build
 * (tsconfig.build.json); executed by `tsc --noEmit`, which is what the
 * release workflow runs. The @ts-expect-error negatives fail the typecheck
 * in BOTH directions: weakening the contract makes a suppression unused,
 * which TypeScript reports.
 */
import type { AssertDbAgentEnv } from './bindings';
import type { DbAgent } from './agent';
import type { DbCollection } from './collection';
import type { DbTable } from './table';

/** This repository's own generated Env is a consumer too. */
export type _SelfCheck = AssertDbAgentEnv<Env>;

interface ConsumerMinimal {
	DbAgent: DurableObjectNamespace<DbAgent>;
	DbCollection: DurableObjectNamespace<DbCollection>;
	DbTable: DurableObjectNamespace<DbTable>;
	DB_EVENTS: AnalyticsEngineDataset;
}
export type _Minimal = AssertDbAgentEnv<ConsumerMinimal>;

interface ConsumerFull extends ConsumerMinimal {
	AUTH_AGENT: Fetcher;
	TRUSTED_ORIGINS: string;
	SENTRY_DSN: string;
	DEMO_MODE: 'true';
	DEMO_TTL_HOURS: string;
}
export type _Full = AssertDbAgentEnv<ConsumerFull>;

interface ConsumerMissingCollection {
	DbAgent: DurableObjectNamespace<DbAgent>;
	DbTable: DurableObjectNamespace<DbTable>;
	DB_EVENTS: AnalyticsEngineDataset;
}
// @ts-expect-error DbCollection is required and must be named in the error.
export type _MissingCollection = AssertDbAgentEnv<ConsumerMissingCollection>;

interface ConsumerMissingTable {
	DbAgent: DurableObjectNamespace<DbAgent>;
	DbCollection: DurableObjectNamespace<DbCollection>;
	DB_EVENTS: AnalyticsEngineDataset;
}
// @ts-expect-error DbTable is required and must be named in the error.
export type _MissingTable = AssertDbAgentEnv<ConsumerMissingTable>;

interface ConsumerWrongType {
	DbAgent: DurableObjectNamespace<DbAgent>;
	DbCollection: DurableObjectNamespace<DbCollection>;
	DbTable: DurableObjectNamespace<DbTable>;
	DB_EVENTS: D1Database;
}
// @ts-expect-error DB_EVENTS must be an AnalyticsEngineDataset.
export type _WrongType = AssertDbAgentEnv<ConsumerWrongType>;

interface ConsumerWrongOptional extends ConsumerMinimal {
	TRUSTED_ORIGINS: number;
}
// @ts-expect-error TRUSTED_ORIGINS is a comma-separated string.
export type _WrongOptional = AssertDbAgentEnv<ConsumerWrongOptional>;
