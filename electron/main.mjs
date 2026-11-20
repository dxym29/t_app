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

async function writeStartupLog(message) {
  try {
    const logPath = path.join(app.getPath('userData'), 'startup.log');
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {}
}

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
    try {
      // Show a visible startup window immediately; database migration and the
      // local server can take time on a first launch.
      mainWindow = new BrowserWindow({
        width: 760,
        height: 420,
        resizable: false,
        center: true,
        autoHideMenuBar: true,
        backgroundColor: '#111318',
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
      });
      await mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
        <!doctype html><html><head><meta charset="utf-8"><title>Webnovel Translator</title>
        <style>body{margin:0;background:#111318;color:#f2f2f2;font:16pxSegoe UI,Arial;display:grid;place-items:center;height:100vh}
        main{text-align:center}h2{font-weight:600;letter-spacing:.3px}p{color:#aeb4c0}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#d5b56b;margin:0 4px;animation:p 1s infinite alternate}@keyframes p{to{opacity:.25}}</style></head>
        <body><main><h2>Webnovel Translator</h2><p>App စတင်နေပါတယ်။ ခဏစောင့်ပေးပါ။</p><span class="dot"></span><span class="dot"></span><span class="dot"></span></main></body></html>`));
      await writeStartupLog('Startup window displayed.');

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
      await writeStartupLog('Environment file loaded.');

      const databasePath = path.join(app.getPath('userData'), 'webnovel-translator.sqlite');
      let migrationComplete = false;
      try {
        const checkDb = new DatabaseSync(databasePath);
        try {
          migrationComplete = Boolean(checkDb.prepare('SELECT migration_key FROM app_migrations WHERE migration_key = ?').get('supabase-snapshot-v1'));
        } catch {}
        checkDb.close();
      } catch {}

      if (!migrationComplete && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
        await writeStartupLog('Starting initial Supabase to SQLite migration.');
        const remote = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
        const migrated = await migrateSupabaseSnapshot({ supabase: remote, databasePath });
        await writeStartupLog('Supabase to SQLite migration verified: ' + JSON.stringify(migrated.counts));
      } else if (!migrationComplete) {
        const local = createSqliteStore(databasePath);
        local.close();
        await writeStartupLog('Initialized an empty SQLite database; no Supabase credentials configured.');
      } else {
        await writeStartupLog('Existing SQLite migration marker found.');
      }

      process.env.DATABASE_MODE = 'sqlite';
      process.env.SQLITE_DATABASE_PATH = databasePath;
      process.env.PORT = String(PORT);
      process.env.HOST = '127.0.0.1';

      if (!process.env.GEMINI_API_KEY) {
        throw new Error('Gemini API settings မတွေ့ပါ။ %APPDATA%\\Webnovel Translator\\.env ဖိုင်ထဲမှာ GEMINI_API_KEY ကို ဖြည့်ပေးပါ။');
      }

      await writeStartupLog('Starting local backend.');
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
      await writeStartupLog('Local backend is ready; loading application window.');

      mainWindow.setResizable(true);
      mainWindow.setSize(1440, 940);
      mainWindow.setMinimumSize(1000, 700);
      mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('https://')) shell.openExternal(url);
        return { action: 'deny' };
      });
      await mainWindow.loadURL(BASE_URL);
      mainWindow.on('closed', () => { mainWindow = null; });
      await writeStartupLog('Application window loaded.');
    } catch (error) {
      const detail = String(error?.stack || error?.message || error);
      console.error('Desktop startup failed:', error);
      await writeStartupLog('STARTUP FAILED: ' + detail);
      await dialog.showMessageBox(mainWindow || undefined, {
        type: 'error',
        title: 'Webnovel Translator',
        message: 'App စတင်မရပါ။',
        detail: detail + '\n\nအသေးစိတ်ကို startup.log ဖိုင်တွင်လည်း သိမ်းထားပါတယ်။'
      });
      app.quit();
    }
  });

  app.on('window-all-closed', () => app.quit());
}
