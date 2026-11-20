import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const TABLES = {
  novels: {
    columns: ['id', 'name', 'style', 'created_at', 'updated_at'],
    order: 'id'
  },
  episodes: {
    columns: ['id', 'novel_id', 'number', 'title', 'source', 'translation', 'model', 'status', 'created_at', 'updated_at'],
    order: 'id'
  },
  glossary_terms: {
    columns: ['id', 'novel_id', 'type', 'original', 'translation', 'note', 'voice', 'created_at'],
    order: 'id'
  }
};

function createSchema(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS novels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      style TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
      number INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      translation TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(novel_id, number)
    );
    CREATE TABLE IF NOT EXISTS glossary_terms (
      id TEXT PRIMARY KEY,
      novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('characters','items','locations','organizations','skills','other')),
      original TEXT NOT NULL,
      translation TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      voice TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE(novel_id, type, original)
    );
    CREATE INDEX IF NOT EXISTS episodes_novel_idx ON episodes(novel_id, number);
    CREATE INDEX IF NOT EXISTS glossary_novel_idx ON glossary_terms(novel_id);
    CREATE TABLE IF NOT EXISTS app_migrations (
      migration_key TEXT PRIMARY KEY,
      completed_at TEXT NOT NULL,
      details_json TEXT NOT NULL
    );
  `);
}

function valueFor(row, column) {
  if (row[column] !== undefined && row[column] !== null) return row[column];
  if (column === 'created_at' || column === 'updated_at') return new Date().toISOString();
  if (column === 'number') return 0;
  return '';
}

async function fetchAllRows(supabase, table, columns, order, initialPageSize) {
  const rows = [];
  let cursor = null;
  let pageSize = Math.min(initialPageSize, 100);

  while (true) {
    let page;
    while (!page) {
      let query = supabase
        .from(table)
        .select(columns.join(', '))
        .order(order, { ascending: true })
        .limit(pageSize);

      // Keyset pagination avoids increasingly expensive OFFSET scans on large
      // tables and keeps each request bounded by the primary-key index.
      if (cursor !== null) query = query.gt(order, cursor);

      const { data, error } = await query;
      if (error) {
        const message = String(error.message || error);
        const isTimeout = /statement timeout|canceling statement|timeout/i.test(message);
        if (isTimeout && pageSize > 10) {
          pageSize = Math.max(10, Math.floor(pageSize / 2));
          continue;
        }
        throw new Error('Supabase export failed for ' + table + ' after reducing page size to ' + pageSize + ': ' + message);
      }

      page = data || [];
      if (page.length && cursor !== null && String(page[0][order]) <= String(cursor)) {
        throw new Error('Supabase export pagination did not advance for ' + table + '.');
      }
    }

    if (!page.length) break;
    rows.push(...page);
    cursor = page[page.length - 1][order];
    if (page.length < pageSize) break;
  }

  return rows;
}

/**
 * Copy a consistent, non-destructive snapshot of the three existing Supabase
 * tables into a local SQLite file. This does not switch the running app to
 * SQLite and never deletes or modifies rows in Supabase.
 */
export async function migrateSupabaseSnapshot({ supabase, databasePath, pageSize = 500 }) {
  if (!supabase) throw new Error('A Supabase client is required for the initial data copy.');
  if (!databasePath) throw new Error('A local SQLite database path is required.');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new Error('pageSize must be an integer between 1 and 1000.');
  }

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    createSchema(db);

    // Read all remote tables before writing anything locally. A failed remote
    // read therefore cannot leave a partially refreshed local snapshot.
    const snapshot = {};
    for (const [table, config] of Object.entries(TABLES)) {
      snapshot[table] = await fetchAllRows(supabase, table, config.columns, config.order, pageSize);
    }

    const counts = Object.fromEntries(
      Object.entries(snapshot).map(([table, rows]) => [table, rows.length])
    );

    db.exec('BEGIN IMMEDIATE');
    try {
      // Parent rows are written first to satisfy SQLite foreign keys.
      for (const table of ['novels', 'episodes', 'glossary_terms']) {
        const columns = TABLES[table].columns;
        const names = columns.join(', ');
        const placeholders = columns.map(() => '?').join(', ');
        const updates = columns.filter(column => column !== 'id')
          .map(column => column + '=excluded.' + column).join(', ');
        const statement = db.prepare(
          'INSERT INTO ' + table + ' (' + names + ') VALUES (' + placeholders + ') ' +
          'ON CONFLICT(id) DO UPDATE SET ' + updates
        );
        for (const row of snapshot[table]) {
          statement.run(...columns.map(column => valueFor(row, column)));
        }
      }

      for (const [table, rows] of Object.entries(snapshot)) {
        const expectedIds = rows.map(row => String(row.id));
        const foundIds = new Set();
        // Chunk IN clauses to stay below SQLite's bind-parameter limit.
        for (let offset = 0; offset < expectedIds.length; offset += 500) {
          const chunk = expectedIds.slice(offset, offset + 500);
          if (!chunk.length) continue;
          const placeholders = chunk.map(() => '?').join(', ');
          const found = db.prepare('SELECT id FROM ' + table + ' WHERE id IN (' + placeholders + ')').all(...chunk);
          for (const item of found) foundIds.add(String(item.id));
        }
        if (foundIds.size !== expectedIds.length) {
          throw new Error('SQLite ID verification failed for ' + table + ': expected ' + expectedIds.length + ', found ' + foundIds.size);
        }
      }

      const details = JSON.stringify({ counts, source: 'supabase', verified: true });
      db.prepare(`
        INSERT INTO app_migrations (migration_key, completed_at, details_json)
        VALUES (?, ?, ?)
        ON CONFLICT(migration_key) DO UPDATE SET
          completed_at=excluded.completed_at,
          details_json=excluded.details_json
      `).run('supabase-snapshot-v1', new Date().toISOString(), details);

      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    return { databasePath, counts, verified: true, sourcePreserved: true };
  } finally {
    db.close();
  }
}
