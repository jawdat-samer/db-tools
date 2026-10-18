# DB Tools

A thin, promise-based data-access layer on top of `mysql2/promise`. It gives you:

- **Tagged-template queries** with parameter binding (via `sql-template-strings`), re-exported as `SQL`.
- **`query` / `query.first` / `query.unique`** for anything that returns rows.
- **`execute`** for statements that don't return rows.
- **`insertOne` / `insertMany`** bulk-insert helpers.
- **`transaction(fn)`** with a scoped `tx` handle.
- **`include`** — declarative relation loading (no N+1, no ORM).

---

## Table of contents

1. [Install / connect](#install--connect)
2. [Quick start](#quick-start)
3. [Connection pool (`db/connection.js`)](#connection-pool-dbconnectionjs)
4. [The `SQL` tag](#the-sql-tag)
5. [`query`](#query)
6. [`query.first` / `query.unique`](#queryfirst--queryunique)
7. [`execute`](#execute)
8. [`insertOne` / `insertMany`](#insertone--insertmany)
9. [`transaction`](#transaction)
10. [Includes (relation loading)](#includes-relation-loading)
11. [Transactions vs. includes](#transactions-vs-includes)
12. [Migrations (`db/migrate.js`)](#migrations-dbmigratejs)
13. [Resetting the database (`db/reset.js`)](#resetting-the-database-dbresetjs)
14. [Type reference](#type-reference)
15. [Gotchas & conventions](#gotchas--conventions)

---

## Install / connect

```js
const db = require('./db'); // exports pool, SQL, query, execute, insertOne, insertMany, transaction
const { query, SQL } = db;
```

`db/index.js` re-exports the pool, so you rarely need to import `./db/connection` directly.

---

## Quick start

```js
const { query, execute, insertOne, transaction, SQL } = require('./db');

// SELECT
const users = await query`SELECT * FROM users WHERE active = 1`;

// SELECT with a bound parameter (safe)
const u = await query.first(SQL`SELECT * FROM users WHERE id = ${id}`);

// INSERT / UPDATE / DELETE
const result = await execute(SQL`UPDATE users SET active = 0 WHERE id = ${id}`);
console.log(result.affectedRows);

// Insert and read back the new id
const { insertId } = await insertOne(SQL`INSERT INTO users (name, email)`, {
  name: 'Ada',
  email: 'ada@example.com',
});

// Transaction
await transaction(async (tx) => {
  const { insertId: userId } = await tx.insertOne(SQL`INSERT INTO users (name)`, { name: 'Ada' });
  await tx.insertOne(SQL`INSERT INTO posts (user_id, title)`, { user_id: userId, title: 'Hello' });
});
```

---

## Connection pool (`db/connection.js`)

`db/connection.js` creates a single shared `mysql2` pool, configured from environment variables:

| Env var             | Default     |
| ------------------- | ----------- |
| `DATABASE_HOST`     | `localhost` |
| `DATABASE_PORT`     | `3306`      |
| `DATABASE_USER`     | `root`      |
| `DATABASE_PASSWORD` | `''`        |
| `DATABASE_NAME`     | `ecommerce` |

Notable pool options:

- **`charset: utf8mb4`**, **`timezone: 'Z'`** — all `DATE`/`DATETIME` values are interpreted as UTC.
- **`supportBigNumbers: true` + `bigNumberStrings: true`** — `BIGINT` is returned as a **string**, so values past `2^53` don't lose precision. Cast to `Number` yourself if you know it's safe.
- **`decimalNumbers: false`** — `DECIMAL` is returned as a **string**. Do money math with a decimal library (e.g. `decimal.js`), not floats.
- **`dateStrings: false`** — `DATE`/`DATETIME` come back as JS `Date` objects.
- **`typeCast`** — `TINYINT(1)` columns are auto-converted to `true`/`false`.

Every pooled connection also runs `SET time_zone = '+00:00'` on connect, so even if the server's default timezone differs, the session is UTC.

---

## The `SQL` tag

`SQL` is re-exported from [`sql-template-strings`](https://www.npmjs.com/package/sql-template-strings). It builds a parameterized statement with `?` placeholders.

```js
const { SQL } = require('./db');

SQL`SELECT * FROM users WHERE id = ${userId} AND active = ${1}`;
// => { sql: 'SELECT * FROM users WHERE id = ? AND active = ?', values: [userId, 1] }
```

**Never** interpolate values into a plain string — always use `SQL` (or pass an explicit `values` array) so the driver can escape them.

Every function that takes a `statement` accepts either:

- a **plain string** (`'SELECT 1'` — no parameters), or
- an **`SQL` template** (an object with `.sql` and `.values`).

### Array binding with `IN (…)`

`sql-template-strings` spreads arrays into a comma-separated list:

```js
const ids = [1, 2, 3];
await query(SQL`SELECT * FROM users WHERE id IN (${ids})`);
// => 'SELECT * FROM users WHERE id IN (?, ?, ?)'  with values [1,2,3]
```

---

## `query`

```ts
query(statement, options?) => Promise<any[]>
```

Runs a statement that returns rows (`SELECT`, `SHOW`, `CALL` returning a result set, …).

### Options

| Option    | Type         | Description                                                                         |
| --------- | ------------ | ----------------------------------------------------------------------------------- |
| `conn`    | `Connection` | Run on this connection instead of the pool.                                         |
| `include` | `IncludeMap` | Relations to attach to the result rows. See [Includes](#includes-relation-loading). |
| `first`   | `boolean`    | Return only the first row (or `null`).                                              |
| `unique`  | `boolean`    | Return the only row (`null` if empty), **throw** if there's more than one.          |

**Shorthand:** passing a `Connection` as the second argument is treated as `{ conn }`:

```js
await query(SQL`SELECT ...`, conn); // same as
await query(SQL`SELECT ...`, { conn });
```

### Examples

```js
// All rows
const users = await query`SELECT * FROM users`;

// Bound parameters
const admins = await query(SQL`SELECT * FROM users WHERE role = ${'admin'}`);

// With a relation
const withPosts = await query(SQL`SELECT * FROM users`, {
  include: {
    posts: {
      parentKey: 'id',
      childKey: 'user_id',
      buildQuery: (ids) => SQL`SELECT * FROM posts WHERE user_id IN (${ids})`,
    },
  },
});
```

> **Note:** `include` runs on the _full_ row array before `first`/`unique` narrows it, so relations are correctly attached to the single row you eventually get back.

---

## `query.first` / `query.unique`

Convenience wrappers that accept the same options as [`query`](#query).

```js
const user = await query.first(SQL`SELECT * FROM users LIMIT 1`); // row | null
const user2 = await query.unique(SQL`SELECT * FROM users WHERE id = ${id}`); // row | null | throws
```

| Method         | Rows returned | No rows | More than one row    |
| -------------- | ------------- | ------- | -------------------- |
| `query.first`  | `rows[0]`     | `null`  | `rows[0]` (silently) |
| `query.unique` | `rows[0]`     | `null`  | **throws**           |

Use `first` when the query is genuinely non-unique and you only want one. Use `unique` when the query _should_ return at most one row and you want to catch a schema/logic bug loudly.

---

## `execute`

```ts
execute(statement, options?) => Promise<any>
```

Runs a statement that does **not** return rows: `INSERT`, `UPDATE`, `DELETE`, DDL, etc. Returns the raw driver result (e.g. the `OkPacket` for `mysql2`).

```js
const result = await execute(SQL`DELETE FROM sessions WHERE expires_at < NOW()`);
console.log(result.affectedRows);

const { insertId } = await execute(SQL`INSERT INTO users (name, email) VALUES (${name}, ${email})`);
```

### Not allowed

`execute` throws a `TypeError` if you pass `include`, `first`, or `unique` — those only make sense for row-returning queries. If you need rows back, use [`query`](#query).

### Options

| Option | Type         | Description                                 |
| ------ | ------------ | ------------------------------------------- |
| `conn` | `Connection` | Run on this connection instead of the pool. |

---

## `insertOne` / `insertMany`

Bulk-insert helpers that build a multi-row `INSERT` from plain objects. Both take a **prefix** — SQL that ends at the column list and contains **no placeholders**.

### `insertOne(prefix, row, options?)`

```js
const res = await insertOne(SQL`INSERT INTO users (name, email)`, {
  name: 'Ada',
  email: 'ada@example.com',
});
console.log(res.insertId);
```

### `insertMany(prefix, rows, options?)`

```js
const res = await insertMany(SQL`INSERT INTO users (name, email)`, [
  { name: 'Ada', email: 'ada@example.com' },
  { name: 'Grace', email: 'grace@example.com' },
]);
```

Generates:

```sql
INSERT INTO users (name, email) VALUES (?, ?), (?, ?)
```

### Rules & validation

- `rows` must be a **non-empty array of plain objects**.
- All rows must have the **same keys**, and those keys must match the **column list in `prefix`**. `insertMany` throws a `TypeError` if any row's keys differ from row 0's.
- The prefix must not contain placeholders (throws if it does).
- Keys are taken from `Object.keys(row)` — order matters for the generated `VALUES`, and it must line up with the columns in your prefix.

> **Tip:** always list columns explicitly in the prefix. `INSERT INTO users` without a column list only works if your object keys happen to be in schema order.

### Options

| Option | Type         | Description                                 |
| ------ | ------------ | ------------------------------------------- |
| `conn` | `Connection` | Run on this connection instead of the pool. |

---

## `transaction`

```ts
transaction(fn: (tx: Tx) => Promise<T> | T) => Promise<T>
```

Borrows a connection from the pool, runs `BEGIN`, calls your function with a [`tx` handle](#tx-handle), then `COMMIT`s on success or `ROLLBACK`s on any thrown error. The connection is always released back to the pool.

```js
const order = await transaction(async (tx) => {
  const { insertId: orderId } = await tx.insertOne(SQL`INSERT INTO orders (user_id, total)`, {
    user_id: userId,
    total,
  });

  await tx.insertMany(
    SQL`INSERT INTO order_items (order_id, sku, qty)`,
    items.map((i) => ({ order_id: orderId, sku: i.sku, qty: i.qty })),
  );

  return orderId;
});
```

If `fn` throws, the transaction rolls back and the error propagates. Use the return value of `fn` to hand data back to the caller.

### `tx` handle

Every method on `tx` runs on the **same** connection, so it's inside the transaction:

| Method                                  | Same as                                             |
| --------------------------------------- | --------------------------------------------------- |
| `tx.query(stmt, options?)`              | `query(stmt, { ...options, conn })`                 |
| `tx.query.first(...)`                   | `query.first` on the tx connection                  |
| `tx.query.unique(...)`                  | `query.unique` on the tx connection                 |
| `tx.execute(stmt, options?)`            | `execute` on the tx connection                      |
| `tx.insertOne(prefix, row, options?)`   | `insertOne` on the tx connection                    |
| `tx.insertMany(prefix, rows, options?)` | `insertMany` on the tx connection                   |
| `tx.conn`                               | The raw `mysql2` connection, for driver-level calls |

> **`conn` is always dropped.** If you accidentally pass `{ conn: someOtherConn }` to a `tx` method, it is silently ignored — the transaction's own connection wins. This prevents you from smuggling a statement onto the pool mid-transaction.

### Nested transactions

There is **no** support for nested transactions or savepoints. If `fn` calls `transaction(...)` again, you'll get a _second_ connection with its own `BEGIN`, which can deadlock against the first. Pass `tx` down instead:

```js
// ❌ Don't
await transaction(async () => {
  await transaction(async (tx) => {
    /* ... */
  });
});

// ✅ Do
await transaction(async (tx) => {
  await doWork(tx);
});

async function doWork(tx) {
  await tx.insertOne(/* ... */);
}
```

---

## Includes (relation loading)

`include` is a declarative way to attach related rows to a result set without writing a loop — the "parent IDs" are collected once, a single query fetches all children, and children are bucketed back onto their parents. No N+1.

### Shape

```js
const users = await query(SQL`SELECT * FROM users`, {
  include: {
    posts: {
      as: 'posts', // property name (defaults to the key)
      parentKey: 'id', // column on the user rows
      childKey: 'user_id', // column on the post rows
      buildQuery: (ids) => SQL`SELECT * FROM posts WHERE user_id IN (${ids})`,
      one: false, // to-many (default) — attach an array
      deleteParentKey: true, // delete `id` from each user row (default)
      include: {
        /* nested includes applied to the posts */
      },
    },
  },
});
```

Each `users[i]` gets a `posts` array. The parent key (`id`) is removed from each user row by default — set `deleteParentKey: false` to keep it.

### Options per relation

| Option            | Default | Description                                                                                  |
| ----------------- | ------- | -------------------------------------------------------------------------------------------- |
| `parentKey`       | —       | Column on the parent row to match against children. **Required.**                            |
| `childKey`        | —       | Column on the child row to match against parents. **Required.**                              |
| `buildQuery(ids)` | —       | Given the de-duped list of parent keys, returns the SQL for fetching children. **Required.** |
| `as`              | key     | Property name on the parent row to attach the relation under.                                |
| `one`             | `false` | `true` = to-one (single object or `null`). `false` = to-many (array).                        |
| `many`            | —       | Deprecated alias for `one: false`. Prefer `one: true` for to-one.                            |
| `deleteParentKey` | `true`  | Delete `parentKey` from each parent row after attaching. Set `false` to keep.                |
| `include`         | —       | Nested `IncludeMap` applied to the attached children.                                        |

### Skip values

- `include: { posts: false }` or `{ posts: null }` — skip that relation.
- `include: []` — no-op (matches "include nothing" semantics).
- `include: { posts: true }` — _would_ include with a bare spec, but you must still supply `parentKey`, `childKey`, and `buildQuery` somewhere. In practice, always pass a full spec object.

### To-one relations

Set `one: true` to attach a single object (or `null`) instead of an array:

```js
const posts = await query(SQL`SELECT * FROM posts`, {
  include: {
    author: {
      one: true,
      parentKey: 'user_id',
      childKey: 'id',
      buildQuery: (ids) => SQL`SELECT * FROM users WHERE id IN (${ids})`,
    },
  },
});
```

> If `one: true` is declared but the query returns **multiple** rows for the same key, `runIncludeOne` **throws**. This catches accidental non-unique joins early. If you truly want last-wins, change `runIncludeOne` — the code points out exactly where.

### Nested includes

`include` composes recursively:

```js
const users = await query(SQL`SELECT * FROM users`, {
  include: {
    posts: {
      parentKey: 'id',
      childKey: 'user_id',
      buildQuery: (ids) => SQL`SELECT * FROM posts WHERE user_id IN (${ids})`,
      include: {
        comments: {
          parentKey: 'id',
          childKey: 'post_id',
          buildQuery: (ids) => SQL`SELECT * FROM comments WHERE post_id IN (${ids})`,
        },
      },
    },
  },
});
```

Each user gets `posts`, and each post gets `comments`.

### Behavior details

- **Null parent keys are skipped.** Parents with `parentKey == null` get `[]` (to-many) or `null` (to-one), and the query is not run at all if every parent key is null.
- **Children with a null `childKey` are dropped** — they can never be bucketed.
- **De-duplication:** only distinct, non-null parent keys are passed to `buildQuery`.
- **`deleteParentKey`** runs _after_ the relation is attached, so the query inside `buildQuery` still sees the original parent key values.

---

## Transactions vs. includes

`tx.query(...)` accepts `include` just like `query(...)` does, and the relation queries run **on the same transaction connection**. This is what you want if the included rows need to be read consistently with the parent read.

```js
await transaction(async (tx) => {
  const users = await tx.query(SQL`SELECT * FROM users`, {
    include: {
      posts: {
        parentKey: 'id',
        childKey: 'user_id',
        buildQuery: (ids) => SQL`SELECT * FROM posts WHERE user_id IN (${ids})`,
      },
    },
  });
  // ...
});
```

---

## Migrations (`db/migrate.js`)

A small forward-only migration runner. It:

1. Creates the database (and `utf8mb4_unicode_ci` charset) if it doesn't exist.
2. Creates a `_migrations` table to record applied files.
3. Acquires a MySQL advisory lock (`GET_LOCK('db_migrate', 30)`) so two migrate processes can't race.
4. Reads `.sql` files from `db/migrations/`, sorts them by numeric prefix, and runs any that aren't yet in `_migrations`.

### Filenames

Migration files must start with a **numeric prefix** followed by an underscore:

```
db/migrations/
  1_init.sql
  2_add_users_email_index.sql
  10_add_orders.sql
```

They're sorted **numerically** on the prefix, so `2_foo.sql` runs before `10_bar.sql` regardless of zero-padding.

### Running it

```bash
node db/migrate.js
```

Or, from a script:

```js
const { run } = require('./db/migrate');
await run();
```

Each `.sql` file may contain **multiple statements** (the connection is created with `multipleStatements: true`).

### Caveat: DDL is not transactional in MySQL

MySQL implicitly commits DDL (`CREATE`, `ALTER`, `DROP`). If a migration file fails halfway through, the schema may be **partially applied**, even though no `_migrations` row was written. When that happens:

1. Fix the schema by hand (or via a corrective migration).
2. Re-run the migrate script.

The advisory lock prevents concurrent runs but does not make DDL atomic.

### Exports

| Export                       | Description                                    |
| ---------------------------- | ---------------------------------------------- |
| `run()`                      | Run pending migrations.                        |
| `ensureDatabaseExists()`     | Create the database if missing.                |
| `MIGRATIONS_DIR`             | Absolute path to `db/migrations`.              |
| `DB_NAME`                    | The database name, from env or default.        |
| `dbConfig(overrides?)`       | Build a mysql connection config from env vars. |
| `assertSafeIdentifier(name)` | Throws if `name` isn't `[A-Za-z0-9_]+`.        |

---

## Resetting the database (`db/reset.js`)

Drops the entire database, recreates it empty, and re-runs all migrations. **Destructive.**

```bash
node db/reset.js --yes                 # in dev
node db/reset.js --yes --force-prod    # if NODE_ENV=production
```

| Flag           | Effect                                                        |
| -------------- | ------------------------------------------------------------- |
| `--yes` / `-y` | Required. Confirms you mean to drop the database.             |
| `--force-prod` | Required _in addition to_ `--yes` when `NODE_ENV=production`. |

The reset holds the **same** `db_migrate` advisory lock used by the migration runner, so it can't run while a migrate is in flight.

### Exports

```js
const { run } = require('./db/reset');
await run(process.argv); // parses --yes / --force-prod
```

---

## Type reference

JSDoc typedefs live in `db/index.js` and drive editor intellisense. Summary:

```ts
type Statement = string | { sql: string; values?: any[] };
type StatementLike = Statement | Promise<Statement>;
type Row = Record<string, any>;

interface Connection {
  query(sql: string, values?: any[]): Promise<[any, any]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

interface QueryOptions {
  conn?: Connection;
  include?: IncludeMap;
  first?: boolean;
  unique?: boolean;
}

interface ExecuteOptions {
  conn?: Connection;
}

interface IncludeSpec {
  parentKey: string;
  childKey: string;
  buildQuery(ids: any[]): StatementLike;
  as?: string;
  one?: boolean;
  many?: boolean; // deprecated: prefer one:true
  deleteParentKey?: boolean; // default true
  include?: IncludeMap;
}

type IncludeMap = Record<string, IncludeSpec | boolean | null>;

interface Tx {
  query: {
    (stmt: Statement, options?: QueryOptions): Promise<any[]>;
    first(stmt: Statement, options?: QueryOptions): Promise<any | null>;
    unique(stmt: Statement, options?: QueryOptions): Promise<any | null>;
  };
  execute(stmt: Statement, options?: ExecuteOptions): Promise<any>;
  insertOne(prefix: Statement, row: Row, options?: ExecuteOptions): Promise<any>;
  insertMany(prefix: Statement, rows: Row[], options?: ExecuteOptions): Promise<any>;
  conn: Connection;
}
```

---

## Gotchas & conventions

- **Always bind parameters.** Use `` SQL`... ${value} ...` `` or an explicit `values` array. Never string-concatenate user input.
- **`BIGINT` and `DECIMAL` come back as strings.** Cast explicitly if you need numbers, and use a decimal library for money.
- **Timezones are UTC.** The pool sets `time_zone = '+00:00'` and interprets `DATE`/`DATETIME` in UTC.
- **`TINYINT(1)` becomes `boolean`.** If you actually want the numeric 0/1, name the column something other than `TINYINT(1)` or adjust `typeCast`.
- **`insertMany` requires matching keys across all rows.** It won't fill in missing columns with `NULL`. If you need that, normalize your rows first.
- **`query.unique` throws on >1 row.** That's a feature — use `query.first` when multiplicity is expected.
- **No nested transactions.** Pass the `tx` handle down instead of calling `transaction` again.
- **`execute` doesn't accept `include` / `first` / `unique`.** Those options only apply to row-returning queries.
- **Includes never N+1.** One query per relation, per level, regardless of how many parents there are.
- **`one: true` includes throw on duplicates.** That's intentional; a to-one relation that returns multiple rows is almost always a bug in the `buildQuery`.
