import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 440,
    height: 540,
    show: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#1C1C1C',
    title: 'Céntrate',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

void app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
