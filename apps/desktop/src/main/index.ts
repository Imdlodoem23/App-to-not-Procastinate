import { join } from 'node:path';
import { app, BrowserWindow, nativeTheme } from 'electron';
import { colors } from '@centrate/shared/design/tokens';

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 440,
    height: 540,
    show: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? colors.dark.bg : colors.light.bg,
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
