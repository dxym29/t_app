import { app, BrowserWindow, dialog, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import dotenv from 'dotenv';
import { DatabaseSync } from 'node:sqlite';
import { createClient } from '@supabase/supabase-js';
import { createSqliteStore } from './sqlite-store.mjs';
import { migrateSupabaseSnapshot } from './sqlite-migration.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = 43127;
app.setPath('userData', path.join(app.getPath('appData'), 'Webnovel Translator'));
const BASE_URL = `http://127.0.0.1:${PORT}`;
let mainWindow;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    // Keep the existing Node/Express application as the local backend.
    // The existing boot scripts generate runtime files beside the app source,
    // so this first desktop build is deliberately unpacked (asar: false).
    process.chdir(app.getAppPath());
    const envPath = path.join(app.getPath('userData'), '.env');
    await fs.mkdir(path.dirname(envPath), { recursive: true });
    try {
      await fs.access(envPath);
    } catch {
      const templatePath = path.join(app.getAppPath(), 'electron', '.env.example');
      const template = await fs.readFile(templatePath, 'utf8');
      await fs.writeFile(envPath, template, { encoding: 'utf8', flag: 'wx' });
    }
    dotenv.config({ path: envPath });
    const databasePath = path.join(app.getPath('userData'), 'webnovel-translator.sqlite');
    let migrationComplete = false;
    try {
      const checkDb = new DatabaseSync(databasePath);
      try { migrationComplete = Boolean(checkDb.prepare("SELECT migration_key FROM app_migrations WHERE migration_key = ?").get('supabase-snapshot-v1')); } catch {}
      checkDb.close();
    } catch {}
    if (!migrationComplete && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const remote = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
      const migrated = await migrateSupabaseSnapshot({ supabase: remote, databasePath });
      console.log('Initial Supabase to SQLite migration verified:', migrated.counts);
    } else if (!migrationComplete) {
      const local = createSqliteStore(databasePath);
      local.close();
      console.log('Initialized an empty local SQLite database; no Supabase credentials were configured.');
    }
    process.env.DATABASE_MODE = 'sqlite';
    process.env.SQLITE_DATABASE_PATH = databasePath;
    process.env.PORT = String(PORT);
    process.env.HOST = '127.0.0.1';

    try {
      if (!process.env.GEMINI_API_KEY) {
        throw new Error('Gemini API settings မတွေ့ပါ။ %APPDATA%\\Webnovel Translator\\.env ဖိုင်ထဲမှာ GEMINI_API_KEY ကို ဖြည့်ပေးပါ။');
      }
      await import('../boot.optimized.mjs');
      let ready = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        try {
          const response = await fetch(BASE_URL, { signal: AbortSignal.timeout(1000) });
          if (response.ok) { ready = true; break; }
        } catch {}
        await delay(250);
      }
      if (!ready) throw new Error('Local Webnovel Translator server did not become ready.');

      mainWindow = new BrowserWindow({
        width: 1440,
        height: 940,
        minWidth: 1000,
        minHeight: 700,
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      });
      mainWindow.once('ready-to-show', () => mainWindow.show());
      mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('https://')) shell.openExternal(url);
        return { action: 'deny' };
      });
      await mainWindow.loadURL(BASE_URL);
      mainWindow.on('closed', () => { mainWindow = null; });
    } catch (error) {
      console.error('Desktop startup failed:', error);
      await dialog.showMessageBox({
        type: 'error',
        title: 'Webnovel Translator',
        message: 'App စတင်မရပါ။',
        detail: String(error?.stack || error?.message || error)
      });
      app.quit();
    }
  });

  app.on('window-all-closed', () => app.quit());
}
