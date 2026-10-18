const pool = require('./connection');
const SQL = require('sql-template-strings');

// ---------- type definitions (for editor intellisense) ----------

/**
 * A SQL statement: either a raw string or an `sql-template-strings` template
 * (an object with `.sql` and `.values`).
 * @typedef {string | { sql: string, values?: any[] }} Statement
 */

/**
 * A SQL statement or a promise that resolves to one. Used by `buildQuery`.
 * @typedef {Statement | Promise<Statement>} StatementLike
 */

/**
 * A database connection (not a pool). Matches the shape returned by
 * `pool.getConnection()`.
 * @typedef {Object} Connection
 * @property {(sql: string, values?: any[]) => Promise<[any, any]>} query
 * @property {() => Promise<void>} beginTransaction
 * @property {() => Promise<void>} commit
 * @property {() => Promise<void>} rollback
 * @property {() => void} release
 */

/**
 * Spec for a single relation to attach under `include`.
 *
 * @typedef {Object} IncludeSpec
 * @property {string} parentKey
 *   Column on the parent row to match against the children.
 * @property {string} childKey
 *   Column on the child row to match against the parents.
 * @property {(ids: any[]) => StatementLike} buildQuery
 *   Receives the de-duplicated list of parent key values and returns the SQL
 *   that fetches the matching children.
 * @property {string} [as]
 *   Property name to attach the relation under. Defaults to the include key.
 * @property {boolean} [one]
 *   Set `true` for a to-one relation (single object or `null`). Default is a
 *   to-many relation (always an array). `many: false` is accepted as an alias.
 * @property {boolean} [many]
 *   Deprecated alias for `one: true` when set to `false`. Prefer `one: true`.
 * @property {boolean} [deleteParentKey]
 *   Delete `parentKey` from each parent row after the relation is attached.
 *   Default `true`. Set to `false` to keep the column.
 * @property {IncludeMap} [include]
 *   Nested includes applied to the attached children.
 */

/**
 * A map of relation name → spec. `true` uses the relation name as `as` with a
 * bare spec (requires `parentKey`, `childKey`, `buildQuery` to be supplied
 * somehow — usually you'll pass a full spec object). `false` / `null` skips.
 * @typedef {Record<string, IncludeSpec | boolean | null>} IncludeMap
 */

/**
 * Options accepted by `query()` and its variants.
 * @typedef {Object} QueryOptions
 * @property {Connection} [conn]
 *   Run against this connection instead of the pool (e.g. inside a transaction).
 * @property {IncludeMap} [include]
 *   Relations to attach after the base query runs.
 * @property {boolean} [first]
 *   Return only the first row, or `null` if there are none.
 * @property {boolean} [unique]
 *   Return the only row, `null` if empty, or throw if more than one row.
 */

/**
 * Options accepted by `execute()` and the insert helpers.
 * @typedef {Object} ExecuteOptions
 * @property {Connection} [conn]
 */

/**
 * Row shape accepted by the insert helpers.
 * @typedef {Record<string, any>} Row
 */

/**
 * Query runner exposed inside a transaction. Same call signatures as the
 * top-level `query`, but always uses the transaction's connection.
 *
 * @typedef {Object} TxQuery
 * @property {(statement: Statement, arg?: QueryOptions) => Promise<any[]>} [call]
 * @property {(statement: Statement, arg?: QueryOptions) => Promise<any | null>} first
 * @property {(statement: Statement, arg?: QueryOptions) => Promise<any | null>} unique
 */

/**
 * Handle passed to the `transaction(fn)` callback.
 * @typedef {Object} Tx
 * @property {TxQuery} query
 * @property {(statement: Statement, arg?: ExecuteOptions) => Promise<any>} execute
 * @property {(prefix: Statement, row: Row, arg?: ExecuteOptions) => Promise<any>} insertOne
 * @property {(prefix: Statement, rows: Row[], arg?: ExecuteOptions) => Promise<any>} insertMany
 * @property {Connection} conn
 *   The raw connection, if you need to talk to the driver directly.
 */

// ---------- helpers ----------

/**
 * @param {Row[]} rows
 * @param {string} key
 * @returns {Map<any, Row[]>}
 */
function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const k = row[key];
    if (k == null) continue; // never bucket null/undefined keys
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return map;
}

/**
 * @param {Statement} stmt
 * @returns {{ sql: string, values: any[] }}
 */
function normalize(stmt) {
  if (typeof stmt === 'string') return { sql: stmt, values: [] };
  if (stmt && typeof stmt.sql === 'string') {
    return { sql: stmt.sql, values: stmt.values || [] };
  }
  throw new TypeError('Statement must be a string or an SQL template');
}

/**
 * @param {any} x
 * @returns {boolean}
 */
function isConnection(x) {
  return (
    x != null &&
    typeof x.query === 'function' &&
    typeof x.beginTransaction === 'function' &&
    typeof x.commit === 'function' &&
    typeof x.rollback === 'function' &&
    typeof x.release === 'function' &&
    typeof x.getConnection !== 'function' // pools have getConnection, connections don't
  );
}

/**
 * Arg may be: a connection, an options object, or nothing.
 * Always returns a plain options object (never a bare connection).
 *
 * @param {QueryOptions | ExecuteOptions | Connection | null} [arg]
 * @returns {QueryOptions & ExecuteOptions}
 */
function toOpts(arg) {
  if (isConnection(arg)) return { conn: arg };
  if (arg == null) return {};
  if (typeof arg !== 'object') {
    throw new TypeError('options argument must be an object or a connection');
  }
  return { ...arg };
}

/**
 * @param {IncludeMap} [include]
 */
function assertIncludeShape(include) {
  if (include == null) return;
  if (Array.isArray(include)) {
    // Empty array = "include nothing" (matches original no-op semantics).
    if (include.length === 0) return;
    throw new TypeError(
      'include must be a plain object of { relationName: spec }. ' +
        'Arrays are not supported (no relation registry exists).',
    );
  }
  if (typeof include !== 'object') {
    throw new TypeError('include must be a plain object of { relationName: spec }');
  }
}

/**
 * True when a spec should be treated as a to-one relation.
 * `one: true` is the canonical form; `many: false` is a deprecated alias.
 *
 * @param {IncludeSpec} spec
 * @returns {boolean}
 */
function isToOne(spec) {
  if (spec.one === true) return true;
  if (spec.many === false) return true;
  return false;
}

// ---------- includes ----------

/**
 * @param {Row[]} parents
 * @param {IncludeSpec & { as: string, deleteParentKey: boolean }} opts
 * @param {Connection} conn
 */
async function runIncludeMany(parents, opts, conn) {
  if (!parents.length) return;
  const { as, parentKey, childKey, buildQuery, deleteParentKey } = opts;
  const ids = [...new Set(parents.map((p) => p[parentKey]).filter((v) => v != null))];

  if (!ids.length) {
    for (const p of parents) {
      p[as] = [];
      if (deleteParentKey) delete p[parentKey];
    }
    return;
  }

  const { sql, values } = normalize(await buildQuery(ids));
  const [rows] = await conn.query(sql, values);
  const grouped = groupBy(rows, childKey);

  for (const p of parents) {
    const k = p[parentKey];
    p[as] = k == null ? [] : grouped.get(k) || [];
    if (deleteParentKey) delete p[parentKey];
  }
}

/**
 * @param {Row[]} parents
 * @param {IncludeSpec & { as: string, deleteParentKey: boolean }} opts
 * @param {Connection} conn
 */
async function runIncludeOne(parents, opts, conn) {
  if (!parents.length) return;
  const { as, parentKey, childKey, buildQuery, deleteParentKey } = opts;
  const ids = [...new Set(parents.map((p) => p[parentKey]).filter((v) => v != null))];

  if (!ids.length) {
    for (const p of parents) {
      p[as] = null;
      if (deleteParentKey) delete p[parentKey];
    }
    return;
  }

  const { sql, values } = normalize(await buildQuery(ids));
  const [rows] = await conn.query(sql, values);

  const byKey = new Map();
  for (const r of rows) {
    const k = r[childKey];
    if (k == null) continue;
    if (byKey.has(k)) {
      // Original code did last-wins; that silently returns the wrong row when
      // the query is non-unique. Fail loudly instead. (To restore last-wins,
      // drop this throw and just `byKey.set(k, r)` unconditionally.)
      throw new Error(
        `include "${as}" is declared one:true but returned multiple rows for key ${String(k)}`,
      );
    }
    byKey.set(k, r);
  }

  for (const p of parents) {
    const k = p[parentKey];
    p[as] = k == null ? null : (byKey.get(k) ?? null);
    if (deleteParentKey) delete p[parentKey];
  }
}

/**
 * @param {Row[]} rows
 * @param {string} as
 * @returns {Row[]}
 */
function collectChildren(rows, as) {
  const out = [];
  for (const p of rows) {
    const v = p[as];
    if (Array.isArray(v)) out.push(...v);
    else if (v != null) out.push(v);
  }
  return out;
}

/**
 * @param {string} name
 * @param {IncludeSpec & { as: string }} spec
 */
function assertIncludeSpec(name, spec) {
  for (const key of ['parentKey', 'childKey', 'buildQuery']) {
    if (spec[key] == null) {
      throw new TypeError(
        `include "${name}" is missing required option "${key}" ` +
          `(needed: parentKey, childKey, buildQuery)`,
      );
    }
  }
}

/**
 * @template T
 * @param {T} result
 * @param {IncludeMap} [include]
 * @param {Connection} conn
 * @returns {Promise<T>}
 */
async function applyIncludes(result, include, conn) {
  if (!include) return result;
  assertIncludeShape(include);

  const isArray = Array.isArray(result);
  const rows = (isArray ? result : [result]).filter((r) => r != null);
  if (!rows.length) return result;

  // Empty-array case short-circuits above via `assertIncludeShape`, and
  // `Object.entries({})` is also empty, so both forms are no-ops here.
  for (const [name, rel] of Object.entries(include)) {
    if (rel === false || rel == null) continue; // explicit skip

    const spec = rel === true ? {} : rel;
    if (typeof spec !== 'object' || Array.isArray(spec)) {
      throw new TypeError(`include "${name}" must be a spec object, true, false, or null`);
    }

    const opts = {
      ...spec,
      as: spec.as || name,
      // Default behavior: strip the parentKey column from each parent row
      // after the relation is attached. Opt out with `deleteParentKey: false`.
      deleteParentKey: spec.deleteParentKey !== false,
    };
    assertIncludeSpec(name, opts);

    if (isToOne(spec)) await runIncludeOne(rows, opts, conn);
    else await runIncludeMany(rows, opts, conn);

    if (spec.include) {
      const children = collectChildren(rows, opts.as);
      if (children.length) await applyIncludes(children, spec.include, conn);
    }
  }
  return result;
}

// ---------- query / execute ----------

/**
 * Run a `SELECT` (or any statement that returns rows).
 *
 * @param {Statement} statement
 *   A SQL string or `sql-template-strings` template.
 * @param {QueryOptions | Connection} [arg]
 *   Options object, or a connection to run on (shorthand for `{ conn }`).
 * @returns {Promise<any[]>}
 *   The result rows (possibly decorated with `include` relations).
 *
 * @example
 *   const users = await query`SELECT * FROM users WHERE active = 1`;
 *
 * @example
 *   const users = await query(SQL`SELECT * FROM users`, {
 *     include: {
 *       posts: {
 *         parentKey: 'id',
 *         childKey: 'user_id',
 *         buildQuery: (ids) => SQL`SELECT * FROM posts WHERE user_id IN (${ids})`,
 *       },
 *     },
 *   });
 */
async function query(statement, arg) {
  const opts = toOpts(arg);
  const conn = opts.conn || pool;
  const { sql, values } = normalize(statement);

  const [rows] = await conn.query(sql, values);

  // Includes run on the full array first, so `include` composes with
  // first/unique — the relations are attached before we pick.
  if (opts.include) await applyIncludes(rows, opts.include, conn);

  if (opts.unique) {
    if (rows.length > 1) {
      throw new Error(
        `query.unique expected at most one row, got ${rows.length}. ` +
          'If the query is legitimately non-unique, use query.first instead.',
      );
    }
    return rows[0] ?? null;
  }

  if (opts.first) return rows[0] ?? null;

  return rows;
}

/**
 * Run a query and return only the first row, or `null` if there are none.
 * Accepts the same options as {@link query}.
 *
 * @type {(statement: Statement, arg?: QueryOptions | Connection) => Promise<any | null>}
 */
query.first = (stmt, arg) => query(stmt, { ...toOpts(arg), first: true });

/**
 * Run a query and return the only row, `null` if empty, or throw if the
 * result has more than one row. Accepts the same options as {@link query}.
 *
 * @type {(statement: Statement, arg?: QueryOptions | Connection) => Promise<any | null>}
 */
query.unique = (stmt, arg) => query(stmt, { ...toOpts(arg), unique: true });

/**
 * Run a statement that does not return rows (`INSERT`, `UPDATE`, `DELETE`,
 * DDL, …). Returns the raw driver result (e.g. `OkPacket` for mysql2).
 *
 * @param {Statement} statement
 * @param {ExecuteOptions | Connection} [arg]
 * @returns {Promise<any>}
 */
async function execute(statement, arg) {
  const opts = toOpts(arg);

  if (opts.include) {
    throw new TypeError('execute() does not support "include" (it does not return rows)');
  }
  if (opts.first || opts.unique) {
    throw new TypeError('execute() does not support "first"/"unique" (it does not return rows)');
  }

  const conn = opts.conn || pool;
  const { sql, values } = normalize(statement);
  const [result] = await conn.query(sql, values);
  return result;
}

// ---------- insert helpers ----------

/**
 * Insert many rows in a single multi-row `INSERT`.
 *
 * @param {Statement} prefix
 *   SQL ending at the column list, e.g.
 *   `` SQL`INSERT INTO users (name, email)` ``. Must not contain placeholders.
 * @param {Row[]} rows
 *   Non-empty array of plain objects. All rows must have the same keys, and
 *   those keys must match the columns in `prefix`.
 * @param {ExecuteOptions | Connection} [arg]
 * @returns {Promise<any>}
 */
async function insertMany(prefix, rows, arg) {
  const { sql: prefixSql, values: prefixValues } = normalize(prefix);
  if (prefixValues.length) {
    throw new TypeError(
      'insertMany: the SQL prefix must not contain placeholders ' +
        '(it should end at the column list).',
    );
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new TypeError('insertMany: rows must be a non-empty array');
  }

  const first = rows[0];
  if (first == null || typeof first !== 'object' || Array.isArray(first)) {
    throw new TypeError('insertMany: rows must be plain objects');
  }

  const columns = Object.keys(first);
  if (columns.length === 0) {
    throw new TypeError('insertMany: rows have no keys');
  }

  const columnSet = new Set(columns);
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r == null || typeof r !== 'object' || Array.isArray(r)) {
      throw new TypeError(`insertMany: row ${i} must be a plain object`);
    }
    const keys = Object.keys(r);
    if (keys.length !== columns.length || !keys.every((k) => columnSet.has(k))) {
      throw new TypeError(
        `insertMany: row ${i} keys [${keys.join(', ')}] don't match row 0 ` +
          `[${columns.join(', ')}]`,
      );
    }
  }

  const rowPlaceholder = `(${columns.map(() => '?').join(', ')})`;
  const placeholders = rows.map(() => rowPlaceholder).join(', ');
  const values = rows.flatMap((row) => columns.map((c) => row[c]));

  return execute({ sql: `${prefixSql} VALUES ${placeholders}`, values }, arg);
}

/**
 * Insert a single row. Thin wrapper around {@link insertMany}.
 *
 * @param {Statement} prefix
 *   Same contract as {@link insertMany}.
 * @param {Row} row
 * @param {ExecuteOptions | Connection} [arg]
 * @returns {Promise<any>}
 */
async function insertOne(prefix, row, arg) {
  if (row == null || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError('insertOne: row must be a plain object');
  }
  return insertMany(prefix, [row], arg);
}

// ---------- transaction ----------

/**
 * Run `fn` inside a transaction. `fn` receives a {@link Tx} handle whose
 * methods all run on the transaction's connection (a stray `conn` option is
 * silently dropped). Commits if `fn` resolves, rolls back if it throws.
 *
 * @template T
 * @param {(tx: Tx) => Promise<T> | T} fn
 * @returns {Promise<T>}
 *
 * @example
 *   await transaction(async (tx) => {
 *     const user = await tx.insertOne(SQL`INSERT INTO users (name)`, { name: 'a' });
 *     await tx.insertOne(SQL`INSERT INTO posts (user_id, title)`, { user_id: user.insertId, title: 'hi' });
 *   });
 */
async function transaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Inside a tx, ALWAYS use the tx connection — never let a stray opts.conn
    // smuggle a statement onto the pool. Drop any `conn` key the caller passed.
    const withTx = (arg) => {
      const opts = toOpts(arg);
      delete opts.conn;
      return { ...opts, conn };
    };

    // tx.query needs its own .first / .unique so `tx.query.first(...)` works.
    // Both routes go through withTx, so they still hit the tx connection.
    const runQuery = (stmt, arg) => query(stmt, withTx(arg));
    runQuery.first = (stmt, arg) => query(stmt, { ...withTx(arg), first: true });
    runQuery.unique = (stmt, arg) => query(stmt, { ...withTx(arg), unique: true });

    /** @type {Tx} */
    const tx = {
      query: runQuery,
      execute: (stmt, arg) => execute(stmt, withTx(arg)),
      insertOne: (prefix, row, arg) => insertOne(prefix, row, withTx(arg)),
      insertMany: (prefix, rows, arg) => insertMany(prefix, rows, withTx(arg)),
      conn,
    };

    const result = await fn(tx);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      /* don't mask original error */
    }
    throw err;
  } finally {
    // Wrap so a release failure can't mask a successful tx result or the
    // original error. `await` handles drivers that return a promise.
    try {
      await conn.release();
    } catch {
      /* ignored */
    }
  }
}

module.exports = { pool, SQL, query, execute, insertOne, insertMany, transaction };