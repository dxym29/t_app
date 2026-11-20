import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSqliteStore } from './sqlite-store.mjs';

test('SQLite adapter preserves CRUD, ordering, pagination, upsert IDs and cascade deletes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webnovel-sqlite-'));
  const databasePath = path.join(directory, 'test.sqlite');
  const db = createSqliteStore(databasePath);
  try {
    const novel = db.from('novels').insert({ name: 'Test Novel', style: 'style' }).select().single();
    return novel.then(async result => {
      assert.equal(result.error, null);
      const novelId = result.data.id;

      const first = await db.from('episodes').insert({ novel_id: novelId, number: 2, title: 'Chapter 2' }).select().single();
      const second = await db.from('episodes').insert({ novel_id: novelId, number: 1, title: 'Chapter 1' }).select().single();
      assert.equal(first.error, null);
      assert.equal(second.error, null);

      const page = await db.from('episodes').select('number,title').eq('novel_id', novelId).order('number').range(0, 0);
      assert.deepEqual(page.data, [{ number: 1, title: 'Chapter 1' }]);

      const updated = await db.from('episodes').update({ translation: 'ဘာသာပြန်ပြီး', updated_at: new Date().toISOString() })
        .eq('id', first.data.id).eq('novel_id', novelId).select().single();
      assert.equal(updated.data.translation, 'ဘာသာပြန်ပြီး');

      const glossary = await db.from('glossary_terms').upsert({
        novel_id: novelId, type: 'characters', original: 'Jiang Qi', translation: 'ကျန်းချီ'
      }, { onConflict: 'novel_id,type,original' }).select().single();
      assert.equal(glossary.error, null);
      const originalId = glossary.data.id;
      const changed = await db.from('glossary_terms').upsert({
        novel_id: novelId, type: 'characters', original: 'Jiang Qi', translation: 'ကျန်းချီအသစ်'
      }, { onConflict: 'novel_id,type,original' }).select().single();
      assert.equal(changed.error, null);
      assert.equal(changed.data.id, originalId);
      assert.equal(changed.data.translation, 'ကျန်းချီအသစ်');

      const removed = await db.from('novels').delete().eq('id', novelId);
      assert.equal(removed.error, null);
      const episodesAfterDelete = await db.from('episodes').select('*').eq('novel_id', novelId);
      const glossaryAfterDelete = await db.from('glossary_terms').select('*').eq('novel_id', novelId);
      assert.deepEqual(episodesAfterDelete.data, []);
      assert.deepEqual(glossaryAfterDelete.data, []);
    }).finally(() => {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    });
  } catch (error) {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
});
