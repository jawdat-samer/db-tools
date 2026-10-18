const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const mysql = require('mysql2/promise');
const { run: runMigrations, DB_NAME, dbConfig, assertSafeIdentifier } = require('./migrate');

const LOCK_NAME = 'db_migrate';
const LOCK_TIMEOUT_SECONDS = 30;

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  return {
    yes: args.has('--yes') || args.has('-y'),
    forceProd: args.has('--force-prod'),
  };
}

async function dropAndRecreateDatabase() {
  assertSafeIdentifier(DB_NAME);

  const conn = await mysql.createConnection(dbConfig());
  try {
    // Hold the same advisory lock the migration runner uses, so a concurrent
    // `migrate` can't be mid-flight while we drop the schema out from under it.
    const [[{ ok }]] = await conn.query('SELECT GET_LOCK(?, ?) AS ok', [
      LOCK_NAME,
      LOCK_TIMEOUT_SECONDS,
    ]);
    if (ok !== 1) {
      throw new Error(
        `Could not acquire "${LOCK_NAME}" within ${LOCK_TIMEOUT_SECONDS}s — ` +
          `is another migrate/reset process running?`,
      );
    }

    try {
      console.log(`🗑  Dropping database \`${DB_NAME}\` ...`);
      await conn.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);

      console.log(`🛠  Creating database \`${DB_NAME}\` ...`);
      await conn.query(`
        CREATE DATABASE \`${DB_NAME}\`
        CHARACTER SET utf8mb4
        COLLATE utf8mb4_unicode_ci
      `);
    } finally {
      try {
        await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
      } catch {
        /* connection dead; MySQL releases on close */
      }
    }
  } finally {
    await conn.end();
  }
}

async function run(argv) {
  const { yes, forceProd } = parseArgs(argv);

  if (process.env.NODE_ENV === 'production' && !forceProd) {
    console.error(
      '❌ Refusing to reset a production database.\n' +
        '   Set NODE_ENV != production, or pass --force-prod if you really mean it.',
    );
    process.exit(1);
  }

  if (!yes) {
    console.error(
      `❌ This will DROP the entire \`${DB_NAME}\` database and re-run all migrations.\n` +
        '   Re-run with --yes to confirm.',
    );
    process.exit(1);
  }

  console.log(`⚠️  Resetting \`${DB_NAME}\` …`);
  await dropAndRecreateDatabase();

  console.log('▶ Running migrations on the fresh database …');
  await runMigrations();

  console.log('🎉 Database reset complete.');
}

if (require.main === module) {
  run(process.argv).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { run };
