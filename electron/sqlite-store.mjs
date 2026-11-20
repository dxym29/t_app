import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TABLES = new Set(['novels', 'episodes', 'glossary_terms']);

export function createSqliteStore(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS novels (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, style TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
      number INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '', translation TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(novel_id, number)
    );
    CREATE TABLE IF NOT EXISTS glossary_terms (
      id TEXT PRIMARY KEY,
      novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('characters','items','locations','organizations','skills','other')),
      original TEXT NOT NULL, translation TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '', voice TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, UNIQUE(novel_id, type, original)
    );
    CREATE INDEX IF NOT EXISTS episodes_novel_idx ON episodes(novel_id, number);
    CREATE INDEX IF NOT EXISTS glossary_novel_idx ON glossary_terms(novel_id);
    CREATE TABLE IF NOT EXISTS app_migrations (
      migration_key TEXT PRIMARY KEY, completed_at TEXT NOT NULL, details_json TEXT NOT NULL
    );
  `);

  class Query {
    constructor(table) {
      if (!TABLES.has(table)) throw new Error('Unknown database table: ' + table);
      this.table = table; this.action = 'select'; this.columns = '*';
      this.values = null; this.filters = []; this.orders = [];
      this.maxRows = null; this.bounds = null; this.returning = false;
      this.singleMode = null; this.conflict = null;
    }
    select(columns = '*') { this.columns = columns; if (this.action !== 'select') this.returning = true; return this; }
    insert(values) { this.action = 'insert'; this.values = Array.isArray(values) ? values : [values]; return this; }
    update(values) { this.action = 'update'; this.values = values; return this; }
    delete() { this.action = 'delete'; return this; }
    upsert(values, options = {}) { this.action = 'upsert'; this.values = Array.isArray(values) ? values : [values]; this.conflict = options.onConflict || 'id'; return this; }
    eq(column, value) { this.filters.push({ column, value }); return this; }
    order(column) {
      for (const part of String(column).split(',')) {
        const [name, direction] = part.trim().split(/\s+/);
        this.orders.push({ name, direction: String(direction || 'asc').toUpperCase() === 'DESC' ? 'DESC' : 'ASC' });
      }
      return this;
    }
    limit(value) { this.maxRows = Number(value); return this; }
    range(from, to) { this.bounds = [Number(from), Number(to)]; return this; }
    single() { this.singleMode = 'single'; return this; }
    maybeSingle() { this.singleMode = 'maybe'; return this; }
    then(resolve, reject) { return this.execute().then(resolve, reject); }
    async execute() {
      try { return { data: this.run(), error: null }; }
      catch (error) { return { data: null, error }; }
    }
    run() {
      const quote = value => {
        if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error('Invalid SQL identifier');
        return '"' + value + '"';
      };
      const where = () => ({
        sql: this.filters.length ? ' WHERE ' + this.filters.map(x => quote(x.column) + ' = ?').join(' AND ') : '',
        args: this.filters.map(x => x.value)
      });
      const project = row => {
        if (!row || this.columns === '*') return row;
        const cols = String(this.columns).split(',').map(x => x.trim()).filter(Boolean);
        return Object.fromEntries(cols.map(c => [c, row[c]]));
      };
      const now = new Date().toISOString();
      const defaults = row => {
        const out = { ...row };
        out.id ||= crypto.randomUUID();
        if (this.table === 'novels') {
          out.name ??= 'New Novel'; out.style ??= '';
          out.created_at ??= now; out.updated_at ??= now;
        } else if (this.table === 'episodes') {
          out.title ??= ''; out.source ??= ''; out.translation ??= '';
          out.model ??= ''; out.status ??= 'draft';
          out.created_at ??= now; out.updated_at ??= now;
        } else {
          out.note ??= ''; out.voice ??= ''; out.created_at ??= now;
        }
        return out;
      };
      const transaction = fn => { this.dbBegin(); try { const v = fn(); this.dbCommit(); return v; } catch (e) { this.dbRollback(); throw e; } };
      if (this.action === 'select') {
        const w = where();
        let sql = 'SELECT * FROM ' + quote(this.table) + w.sql;
        if (this.orders.length) sql += ' ORDER BY ' + this.orders.map(o => quote(o.name) + ' ' + o.direction).join(', ');
        if (this.bounds) sql += ' LIMIT ' + (this.bounds[1] - this.bounds[0] + 1) + ' OFFSET ' + this.bounds[0];
        else if (this.maxRows !== null) sql += ' LIMIT ' + Math.max(0, this.maxRows);
        const rows = db.prepare(sql).all(...w.args).map(project);
        if (this.singleMode === 'single') {
          if (rows.length !== 1) throw new Error('Expected exactly one row, received ' + rows.length);
          return rows[0];
        }
        if (this.singleMode === 'maybe') {
          if (rows.length > 1) throw new Error('Expected at most one row, received ' + rows.length);
          return rows[0] || null;
        }
        return rows;
      }
      if (this.action === 'insert' || this.action === 'upsert') {
        const rows = this.values.map(defaults);
        const keys = [...new Set(rows.flatMap(r => Object.keys(r)))];
        const conflictKeys = this.action === 'upsert' ? String(this.conflict || 'id').split(',').map(x => x.trim()) : ['id'];
        const updateKeys = keys.filter(k => !conflictKeys.includes(k));
        const sql = 'INSERT ' + (this.action === 'upsert' ? '' : '') + 'INTO ' + quote(this.table) +
          ' (' + keys.map(quote).join(', ') + ') VALUES (' + keys.map(() => '?').join(', ') + ')' +
          (this.action === 'upsert' ? ' ON CONFLICT (' + conflictKeys.map(quote).join(', ') + ') ' +
            (updateKeys.length ? 'DO UPDATE SET ' + updateKeys.map(k => quote(k) + '=excluded.' + quote(k)).join(', ') : 'DO NOTHING') : '');
        transaction(() => { const stmt = db.prepare(sql); for (const row of rows) stmt.run(...keys.map(k => row[k] ?? null)); });
        if (!this.returning) return null;
        const ids = rows.map(r => r.id);
        const found = [];
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const condition = conflictKeys.map(k => quote(k) + ' = ?').join(' AND ');
          const actual = db.prepare('SELECT * FROM ' + quote(this.table) + ' WHERE ' + condition).get(...conflictKeys.map(k => row[k]));
          if (actual) found.push(project(actual));
        }
        if (this.singleMode === 'single') { if (found.length !== 1) throw new Error('Expected exactly one row, received ' + found.length); return found[0]; }
        return found;
      }
      const w = where();
      if (this.action === 'update') {
        const entries = Object.entries(this.values || {});
        if (!entries.length) return [];
        const sql = 'UPDATE ' + quote(this.table) + ' SET ' + entries.map(([k]) => quote(k) + '=?').join(', ') + w.sql;
        const changed = db.prepare(sql).run(...entries.map(([,v]) => v), ...w.args);
        if (!this.returning) return null;
        const rows = db.prepare('SELECT * FROM ' + quote(this.table) + w.sql).all(...w.args).map(project);
        if (this.singleMode === 'single') { if (rows.length !== 1) throw new Error('Expected one updated row, affected ' + changed.changes); return rows[0]; }
        return rows;
      }
      if (this.action === 'delete') {
        db.prepare('DELETE FROM ' + quote(this.table) + w.sql).run(...w.args);
        return null;
      }
      throw new Error('Unsupported database operation: ' + this.action);
    }
    dbBegin() { db.exec('BEGIN IMMEDIATE'); }
    dbCommit() { db.exec('COMMIT'); }
    dbRollback() { db.exec('ROLLBACK'); }
  }
  return {
    from(table) { const query = new Query(table); return query; },
    close() { db.close(); },
    raw: db
  };
}
