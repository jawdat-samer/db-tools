const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const fs = require('fs');
const mysql = require('mysql2/promise');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const DB_NAME = process.env.DATABASE_NAME || 'ecommerce';
const LOCK_NAME = 'db_migrate';
const LOCK_TIMEOUT_SECONDS = 30;

function dbConfig(overrides = {}) {
  const rawPort = Number(process.env.DATABASE_PORT);
  const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : 3306;
  return {
    host: process.env.DATABASE_HOST || 'localhost',
    port,
    user: process.env.DATABASE_USER || 'root',
    password: process.env.DATABASE_PASSWORD || '',
    charset: 'utf8mb4',
    timezone: 'Z',
    ...overrides,
  };
}

function assertSafeIdentifier(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`Unsafe database identifier: ${JSON.stringify(name)}`);
  }
}

async function ensureDatabaseExists() {
  assertSafeIdentifier(DB_NAME);
  const conn = await mysql.createConnection(dbConfig());
  try {
    await conn.query(`
      CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`
      CHARACTER SET utf8mb4
      COLLATE utf8mb4_unicode_ci
    `);
    console.log(`✅ Database \`${DB_NAME}\` is ready.`);
  } finally {
    await conn.end();
  }
}

async function ensureMigrationsTable(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INT NOT NULL AUTO_INCREMENT,
      name VARCHAR(255) NOT NULL,
      appliedAt TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY _migrations_name_key (name)
    ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
  `);
}

async function getApplied(conn) {
  const [rows] = await conn.query('SELECT name FROM _migrations');
  return new Set(rows.map((r) => r.name));
}

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(`Migrations directory not found: ${MIGRATIONS_DIR}`);
  }
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));

  // Every filename must start with a numeric prefix. Sort by that prefix
  // numerically, so 2_foo.sql sorts before 10_bar.sql regardless of padding.
  for (const f of files) {
    if (!/^\d+_/.test(f)) {
      throw new Error(`Migration filename must start with a numeric prefix: ${f}`);
    }
  }

  return files.sort((a, b) => {
    const na = parseInt(a, 10);
    const nb = parseInt(b, 10);
    return na - nb || a.localeCompare(b);
  });
}

async function run() {
  await ensureDatabaseExists();

  // Single dedicated connection: holds the advisory lock AND runs the SQL.
  // multipleStatements lets one .sql file contain multiple statements.
  const conn = await mysql.createConnection(
    dbConfig({ database: DB_NAME, multipleStatements: true }),
  );

  // Force every pooled connection to UTC.
  conn.on('connection', (conn) => {
    conn.query("SET time_zone = '+00:00'", (err) => {
      if (err) throw err;
    });
  });

  try {
    // Serialize concurrent migrate runs. GET_LOCK is per-session; if this
    // connection dies, MySQL releases the lock automatically.
    const [[{ ok }]] = await conn.query('SELECT GET_LOCK(?, ?) AS ok', [
      LOCK_NAME,
      LOCK_TIMEOUT_SECONDS,
    ]);
    if (ok !== 1) {
      throw new Error(
        `Could not acquire migration lock "${LOCK_NAME}" within ` +
          `${LOCK_TIMEOUT_SECONDS}s — is another migrate process running?`,
      );
    }

    try {
      await ensureMigrationsTable(conn);
      const applied = await getApplied(conn);

      const pending = listMigrationFiles().filter((f) => !applied.has(f));
      if (pending.length === 0) {
        console.log('✅ No pending migrations.');
        return;
      }

      for (const file of pending) {
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        if (!sql.trim()) {
          console.log(`⏭  Skipping empty ${file}`);
          continue;
        }

        console.log(`▶ Applying ${file} ...`);

        // NOTE: MySQL implicitly commits DDL, so a mid-file failure can leave
        // the schema partially migrated even though no _migrations row is
        // written. If that happens, fix the DB by hand and re-run. The
        // advisory lock above prevents a second process from racing in here.
        try {
          await conn.query(sql);
          await conn.query('INSERT INTO _migrations (name) VALUES (?)', [file]);
          console.log(`✅ Applied ${file}`);
        } catch (err) {
          console.error(`❌ Failed ${file}:`, err.message);
          throw err;
        }
      }

      console.log('🎉 Migrations complete.');
    } finally {
      try {
        await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
      } catch {
        // connection is probably dead; MySQL drops the lock on close anyway
      }
    }
  } finally {
    await conn.end();
  }
}

// Only auto-run when this file is the entry point; safe to require() from
// reset.js (and later from tests).
if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  run,
  ensureDatabaseExists,
  MIGRATIONS_DIR,
  DB_NAME,
  dbConfig,
  assertSafeIdentifier,
};
