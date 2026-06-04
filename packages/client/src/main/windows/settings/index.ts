import { BrowserWindow, app } from 'electron';
import path from 'path';

export async function createSettingsModal(parent : BrowserWindow) : Promise<BrowserWindow> {
    const modal = new BrowserWindow({
        parent,
        modal: true,
        show: true,
        webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            sandbox: false, // Disable sandboxing for compatibility with some libraries
            webSecurity: app.isPackaged, // Disable web security only in development for CORS
            
        },
        icon: path.join(__dirname, 'icons/icon.png'),
        titleBarStyle: 'hidden',
        resizable: false
    });

    modal.setMenu(null);
    // Allow pressing F12 to open dev tools
    modal.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'F12' && input.type === 'keyDown') {
            event.preventDefault();
            modal.webContents.toggleDevTools();
        }
    });
    if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
        modal.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/settings.html`);
    } else {
        modal.loadFile(path.join(__dirname, '../renderer/settings.html'));
    }

    return modal;
}