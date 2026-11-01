// ARCHIVE_OS desktop app (Electron): runs the proxy server inside the app and opens it in its own window.
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

process.env.PORT = process.env.PORT || '3000';
require('./server.js');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#0a0a0a',
    title: 'ARCHIVE_OS',
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadURL('http://localhost:' + process.env.PORT);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  setTimeout(createWindow, 600);
});
app.on('window-all-closed', () => app.quit());
