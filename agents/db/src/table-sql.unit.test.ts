import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareTableSql } from './table-sql';
import { compileTableAggregate } from './table-query';
import { tableColumnsSchema, type TableColumn } from './schemas';

/** The raw-SQL gate exists to refuse bypasses; pin the refusals hardest. */

function cols(...input: Record<string, unknown>[]): TableColumn[] {
	return tableColumnsSchema.parse(input);
}

const TODO = cols(
	{ name: 'title', type: 'text' },
	{ name: 'votes', type: 'integer' },
	{ name: 'meta', type: 'json' },
);

function ok(sql: string) {
	const prepared = prepareTableSql(sql, 'todos', TODO);
	if (!prepared.ok) throw new Error(`expected to pass the gate: ${prepared.error}`);
	return prepared;
}

function refused(sql: string, fragment: string) {
	const prepared = prepareTableSql(sql, 'todos', TODO);
	assert.equal(prepared.ok, false, `should refuse: ${sql}`);
	if (!prepared.ok) assert.match(prepared.error, new RegExp(fragment), sql);
}

test('sql gate: plain statements pass and DML gains RETURNING', () => {
	const select = ok('SELECT "id", "title" FROM "todos" WHERE "votes" > ?');
	assert.equal(select.kind, 'select');
	assert.ok(!/returning/i.test(select.sql));

	const insert = ok(`INSERT INTO todos (id, title, votes) VALUES (?, ?, ?);`);
	assert.equal(insert.kind, 'insert');
	assert.match(
		insert.sql,
		/RETURNING "id", "owner", "created_at", "updated_at", "title", "votes", "meta"$/,
	);

	const update = ok(`update "todos" set votes = votes + 1 where id = ?`);
	assert.equal(update.kind, 'update');
	assert.match(update.sql, /RETURNING/);

	const remove = ok(`DELETE FROM todos WHERE votes < ?`);
	assert.equal(remove.kind, 'delete');
	assert.match(remove.sql, /RETURNING/);
});

test('sql gate: multiple statements, DDL, and transactions are refused', () => {
	refused('SELECT 1; SELECT 2', 'one statement');
	refused('DROP TABLE todos', 'SELECT, INSERT, UPDATE');
	refused('CREATE INDEX x ON todos (title)', 'SELECT, INSERT, UPDATE');
	refused('SELECT * FROM todos; --', 'one statement');
	refused('BEGIN', 'SELECT, INSERT, UPDATE');
	refused("SELECT * FROM todos WHERE title = 'x'; DELETE FROM todos", 'one statement');
	refused('PRAGMA table_info(todos)', 'SELECT, INSERT, UPDATE');
	refused('SELECT * FROM todos JOIN pragma_table_info(?) LIMIT 1', 'plain SELECT');
});

test('sql gate: internal storage is unreachable, whatever the casing', () => {
	refused('SELECT * FROM changelog', 'internal storage');
	refused('SELECT * FROM "CHANGELOG"', 'internal storage');
	refused('SELECT token_exp FROM subscriptions', 'internal storage');
	refused('SELECT t.* FROM todos t, replica_meta', 'internal storage');
	refused('SELECT * FROM sqlite_master', 'sqlite internals');
	// Even in a string literal: bind it instead.
	refused(`SELECT * FROM todos WHERE title = 'changelog'`, 'bind it as a parameter');
});

test('sql gate: DML must target this table; RETURNING is ours to add', () => {
	refused('INSERT INTO other (id) VALUES (?)', 'must target "todos"');
	refused('UPDATE elsewhere SET x = 1', 'must target "todos"');
	refused('DELETE FROM other', 'must target "todos"');
	refused('INSERT INTO todos (id) VALUES (?) RETURNING id', 'added automatically');
	refused('WITH x AS (SELECT 1) INSERT INTO todos (id) SELECT * FROM x', 'CTEs');
	// A CTE-fronted SELECT is legitimate ORM output.
	const cte = ok(
		'WITH ranked AS (SELECT id, votes FROM todos) SELECT * FROM ranked WHERE votes > ?',
	);
	assert.equal(cte.kind, 'select');
});

test('table aggregates: typed columns sum directly, json paths stay gated', () => {
	const typed = compileTableAggregate(
		'todos',
		{
			where: [{ field: 'title', op: '==', value: 'x' }],
			aggregates: { total: { op: 'count' }, v: { op: 'sum', field: 'votes' } },
		},
		TODO,
	);
	assert.equal(typed.ok, true, !typed.ok ? new Error(typed.error) : undefined);
	if (typed.ok) {
		assert.equal(
			typed.compiled.sql,
			`SELECT COUNT(*) AS agg_0, COALESCE(SUM("votes"), 0) AS agg_1 FROM "todos" WHERE "title" = ?`,
		);
		assert.deepEqual(typed.compiled.aliases, ['total', 'v']);
	}

	const json = compileTableAggregate(
		'todos',
		{ aggregates: { avg: { op: 'avg', field: 'meta.score' } } },
		TODO,
	);
	assert.equal(json.ok, true);
	if (json.ok)
		assert.match(json.compiled.sql, /json_type\("meta", '\$\.score'\) IN \('integer', 'real'\)/);

	const text = compileTableAggregate(
		'todos',
		{ aggregates: { s: { op: 'sum', field: 'title' } } },
		TODO,
	);
	assert.equal(text.ok, false);
	if (!text.ok) assert.match(text.error, /text column/);

	const unknown = compileTableAggregate(
		'todos',
		{ aggregates: { s: { op: 'sum', field: 'ghost' } } },
		TODO,
	);
	assert.equal(unknown.ok, false);
});
