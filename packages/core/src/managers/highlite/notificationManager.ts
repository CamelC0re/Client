/*! 

Copyright (C) 2025  HighLite

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.

*/

export class NotificationManager {
    private static instance: NotificationManager;
    canNotify = false;

    constructor() {
        if (NotificationManager.instance) {
            return NotificationManager.instance;
        }

        if (document.highlite.managers.NotificationManager) {
            NotificationManager.instance = document.highlite.managers.NotificationManager;
            return document.highlite.managers.NotificationManager;
        }

        NotificationManager.instance = this;
        document.highlite.managers.NotificationManager = this;
    }

    createNotification(
        message: string,
        onClick: Function = () => {
            window.focus();
        }
    ): boolean {
        if (!this.canNotify) {
            return false;
        }

        const notification = new Notification('Ryelite', {
            icon: './static/icons/icon.png',
            body: message,
        });
        notification.onclick = () => {
            onClick();
        };

        return true;
    }

    async askNotificationPermission() {
        // Check if the browser supports notifications
        if (!('Notification' in window)) {
            console.info(
                '[Ryelite] This browser does not support notifications.'
            );
            this.canNotify = false;
        }

        if (Notification.permission === 'granted') {
            console.info('[Ryelite] Notification permission granted.');
            this.canNotify = true;
        } else if (Notification.permission === 'denied') {
            console.info('[Ryelite] Notification permission denied.');
            this.canNotify = false;
        } else {
            console.info('[Ryelite] Notification permission dismissed.');
            this.canNotify = false;
        }
    }
}
