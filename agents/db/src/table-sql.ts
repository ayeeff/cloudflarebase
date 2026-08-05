import { selectList } from './table-schema';
import type { TableColumn } from './schemas';

/**
 * The raw-SQL gate for the D1-shaped table endpoint (T2 of
 * docs/db-scale-plan.md, design in docs/db-table-design.md §10). Pure
 * module, unit-tested against bypass attempts.
 *
 * The physical table is named after the declared table with plain system
 * columns, so ORM-generated SQL runs unmodified - the gate's job is not to
 * parse SQL, but to refuse what must never run:
 *
 * - anything but a single SELECT/INSERT/UPDATE/DELETE statement (DDL is the
 *   column DSL's monopoly; transactions are the batch endpoint's);
 * - any reference to the shard's INTERNAL tables (subscriptions carries
 *   token metadata, changelog carries every row image - a raw SELECT over
 *   either would bypass access modes entirely) or sqlite_* internals;
 * - user-supplied RETURNING (the endpoint appends its own, which is how DML
 *   feeds the change log and the live engine).
 *
 * The internal-name scan is deliberately dumb: a case-insensitive word match
 * over the WHOLE statement, string literals included. A literal containing
 * "changelog" is refused with a clear error - bind it as a parameter, which
 * is what an ORM does anyway. False positives are the cost of no parser;
 * false negatives are the thing this module exists to prevent.
 */

export type SqlKind = 'select' | 'insert' | 'update' | 'delete';

export type PreparedSql =
	| { ok: true; kind: SqlKind; sql: string }
	| { ok: false; error: string };

/** Internal storage no raw statement may name, whatever the casing. */
const INTERNAL_NAMES = [
	'documents',
	'subscriptions',
	'collection_meta',
	'changelog',
	'replicas',
	'replica_meta',
	'__drizzle_migrations',
];

const KIND_PATTERN = /^\s*(select|insert|update|delete|with)\b/i;

export function prepareTableSql(
	rawSql: string,
	table: string,
	columns: TableColumn[],
): PreparedSql {
	let sql = rawSql.trim();
	// One trailing semicolon is tolerated (ORMs emit it); any other semicolon
	// means a second statement - refused, string literals included (bind
	// values as parameters instead).
	if (sql.endsWith(';')) sql = sql.slice(0, -1).trimEnd();
	if (sql.includes(';')) {
		return { ok: false, error: 'one statement per call - batch for more' };
	}

	const kindMatch = KIND_PATTERN.exec(sql);
	if (!kindMatch) {
		return {
			ok: false,
			error:
				'only SELECT, INSERT, UPDATE, and DELETE run here - schema changes go through the column DSL',
		};
	}
	let kind: SqlKind;
	if (kindMatch[1].toLowerCase() === 'with') {
		// A CTE may only front a SELECT: DML behind WITH would dodge the
		// target-table shape checks below.
		if (/\b(insert|update|delete)\b/i.test(sql)) {
			return { ok: false, error: 'CTEs are supported for SELECT only' };
		}
		kind = 'select';
	} else {
		kind = kindMatch[1].toLowerCase() as SqlKind;
	}

	const lowered = sql.toLowerCase();
	for (const name of INTERNAL_NAMES) {
		if (name === table) continue; // a user table may legitimately shadow none of these, but stay safe
		if (new RegExp(`\\b${name}\\b`).test(lowered)) {
			return {
				ok: false,
				error: `"${name}" is internal storage - if you meant the literal string, bind it as a parameter`,
			};
		}
	}
	if (/\bsqlite_\w+/.test(lowered)) {
		return { ok: false, error: 'sqlite internals are not queryable here' };
	}
	// `pragma\w*` also catches the function forms (pragma_table_info & co).
	if (/\b(pragma\w*|attach|detach|vacuum|reindex|alter|create|drop|begin|commit|rollback|savepoint)\b/.test(lowered)) {
		return {
			ok: false,
			error: 'only plain SELECT/INSERT/UPDATE/DELETE statements run here',
		};
	}
	if (kind !== 'select' && /\breturning\b/.test(lowered)) {
		return {
			ok: false,
			error: 'RETURNING is added automatically - the full row always comes back',
		};
	}

	// DML must target THIS table by its unquoted or quoted name.
	const t = `("?)${escapeRegExp(table)}\\1`;
	if (kind === 'insert' && !new RegExp(`^insert\\s+(or\\s+\\w+\\s+)?into\\s+${t}\\b`, 'i').test(sql)) {
		return { ok: false, error: `inserts must target "${table}"` };
	}
	if (kind === 'update' && !new RegExp(`^update\\s+(or\\s+\\w+\\s+)?${t}\\b`, 'i').test(sql)) {
		return { ok: false, error: `updates must target "${table}"` };
	}
	if (kind === 'delete' && !new RegExp(`^delete\\s+from\\s+${t}\\b`, 'i').test(sql)) {
		return { ok: false, error: `deletes must target "${table}"` };
	}

	// DML answers with the full row: the change log and the live engine are
	// fed from exactly what the statement touched.
	if (kind !== 'select') {
		sql = `${sql} RETURNING ${selectList(columns)}`;
	}

	return { ok: true, kind, sql };
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
