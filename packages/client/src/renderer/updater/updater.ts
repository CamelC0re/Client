// Copyright (C) 2025  HighLite

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.


import '@iconify/iconify';

// Update Progress UI elements
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const updateStatus = $('update-status');
const progressLoader = $('progressLoader');
const progressBar = $('progressBar') as HTMLDivElement;
const progressLabel = $('progressLabel');
const sectionUpdateChange = $('update-change');
const releaseNotes = $('releaseNotes');
const btnUpdateNow = $('updateNow') as HTMLButtonElement;
const btnUpdateLater = $('updateLater') as HTMLButtonElement;
const btnRestartNow = $('restartNow') as HTMLButtonElement;
const btnRestartLater = $('restartLater') as HTMLButtonElement;
const closeBtn = $('closeBtn') as HTMLAnchorElement;

// Obtain the update progress from the main process
window.electron.ipcRenderer.on('download-progress', (_, progress) => {
    // Round the progress to the nearest integer
    progress = Math.round(progress);
    updateStatus.textContent = `Downloading update...`;
    progressBar.style.width = `${progress}%`;
    progressBar.parentElement?.setAttribute('aria-valuenow', String(progress));
    progressLabel.textContent = `${progress}%`;
});

window.electron.ipcRenderer.on('update-downloaded', _ => {
    console.log('Update downloaded');
    updateStatus.textContent = `Update Ready!`;
    progressLoader.style.visibility = 'hidden';
    btnRestartNow.style.display = 'block';
    btnRestartLater.style.display = 'block';
    btnUpdateNow.style.display = 'none';
    btnUpdateLater.style.display = 'none';
});

window.electron.ipcRenderer.on('update-available', (_, releaseInfo) => {
    updateStatus.textContent = 'Update to ' + releaseInfo.releaseName + ' Available!';
    progressLoader.style.visibility = 'hidden';
    btnUpdateNow.style.display = 'block';
    btnUpdateLater.style.display = 'block';
    // Show release notes section (block layout in mobile, grid/column later)
    sectionUpdateChange.style.display = 'block';
    releaseNotes.innerHTML = releaseInfo.releaseNotes;
});

// When updateNow is clicked, send the install-update event to the main process
btnUpdateNow.addEventListener('click', () => {
    window.electron.ipcRenderer.send('download-update');

    // Disable the buttons
    btnUpdateNow.style.display = 'none';
    btnUpdateLater.style.display = 'none';

    updateStatus.textContent = `Downloading update...`;
    progressLoader.style.visibility = 'visible';
    progressBar.style.width = '0%';
    progressBar.parentElement?.setAttribute('aria-valuenow', '0');
    progressLabel.textContent = '0%';
});

btnRestartNow.addEventListener('click', () => {
    window.electron.ipcRenderer.send('install-update');
    // Disable the buttons
    btnRestartNow.disabled = true;
    btnRestartLater.disabled = true;
});

btnRestartLater.addEventListener('click', () => {
    window.electron.ipcRenderer.send('delay-update');
    // Disable the buttons
    btnRestartNow.disabled = true;
    btnRestartLater.disabled = true;
});

btnUpdateLater.addEventListener('click', () => {
    window.electron.ipcRenderer.send('delay-update');
    // Disable the buttons
    btnUpdateNow.disabled = true;
    btnUpdateLater.disabled = true;
});

closeBtn.addEventListener('click', () => {
    window.electron.ipcRenderer.send('delay-update');
});

const isDarwin = window.electron.process.platform === 'darwin';

// Hide the window controls if the OS is Darwin (macOS)
if(isDarwin) {
    document.getElementById('window-controls')?.remove();
} else {
    document.getElementById('darwin-spacer')?.remove();
}