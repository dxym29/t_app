import { app, BrowserWindow, dialog, shell } from 'electron';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = 43127;
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
    process.env.PORT = String(PORT);
    process.env.HOST = '127.0.0.1';

    try {
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
