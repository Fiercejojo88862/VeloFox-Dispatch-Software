'use strict';

/**
 * PostgreSQL access layer.
 *
 * One shared pool per process (Vercel keeps a warm instance alive between
 * invocations), schema bootstrap guarded by an advisory lock and a migration
 * marker, plus small query helpers.
 */

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const SCHEMA_PATH = path.join(__dirname, '..', 'schema.sql');
const MIGRATION_ID = 'schema-v9-ride-verification';
const LOCK_KEY = 728_193_554;

let pool = null;
let bootstrapPool = null;
let schemaPromise = null;

function databaseUrl() {
  return process.env.DATABASE_URL || '';
}

/**
 * Schema bootstrap takes a session-level advisory lock. A transaction-mode
 * pooler (Neon's `-pooler` host) can hand that session to another client
 * between statements, so migrations go through the direct URL when the host
 * provides one.
 */
function bootstrapUrl() {
  return process.env.DATABASE_URL_UNPOOLED || databaseUrl();
}

function isConfigured() {
  return Boolean(databaseUrl());
}

function needsSsl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const mode = parsed.searchParams.get('sslmode');
  if (mode === 'disable') return false;
  if (mode === 'require' || mode === 'verify-ca' || mode === 'verify-full') return true;
  return !['localhost', '127.0.0.1', '::1', 'postgres'].includes(parsed.hostname);
}

function createPool(url) {
  const max = Number(process.env.PG_POOL_MAX)
    || (process.env.VERCEL ? 1 : 10);

  const created = new Pool({
    connectionString: url,
    max,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    ssl: needsSsl(url) ? { rejectUnauthorized: false } : undefined,
  });

  created.on('error', (error) => {
    console.error('[db] idle client error:', error.message);
  });

  // Lets Vercel drain idle clients before the instance is frozen or recycled.
  if (process.env.VERCEL) {
    try {
      require('@vercel/functions').attachDatabasePool(created);
    } catch (error) {
      console.warn('[db] pool attach skipped:', error.message);
    }
  }

  return created;
}

function getPool() {
  const url = databaseUrl();
  if (!url) throw new Error('DATABASE_URL is not set. Configure a PostgreSQL connection string.');

  if (!pool) pool = createPool(url);

  return pool;
}

function getBootstrapPool() {
  const url = bootstrapUrl();
  if (!url) throw new Error('DATABASE_URL is not set. Configure a PostgreSQL connection string.');

  if (!bootstrapPool) bootstrapPool = createPool(url);

  return bootstrapPool;
}

function query(text, params = []) {
  return getPool().query(text, params);
}

async function withTransaction(work) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already gone */
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Applies schema.sql exactly once per database. Safe under concurrent cold
 * starts: a Postgres advisory lock serialises the bootstrap.
 */
async function ensureSchema() {
  if (!isConfigured()) throw new Error('DATABASE_URL is not set.');
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    const client = await getBootstrapPool().connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id          text PRIMARY KEY,
          applied_at  timestamptz NOT NULL DEFAULT now()
        )
      `);

      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [MIGRATION_ID]);
      if (applied.rowCount > 0) return;

      await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
      try {
        const recheck = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [MIGRATION_ID]);
        if (recheck.rowCount === 0) {
          const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT DO NOTHING', [MIGRATION_ID]);
        }
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  })().catch((error) => {
    schemaPromise = null;
    throw error;
  });

  return schemaPromise;
}

async function healthCheck() {
  const result = await query('SELECT 1 AS ok');
  return result.rows[0].ok === 1;
}

async function close() {
  const current = pool;
  const currentBootstrap = bootstrapPool;
  pool = null;
  bootstrapPool = null;
  schemaPromise = null;
  if (current) await current.end();
  if (currentBootstrap) await currentBootstrap.end();
}

module.exports = {
  isConfigured,
  getPool,
  getBootstrapPool,
  query,
  withTransaction,
  ensureSchema,
  healthCheck,
  close,
};
