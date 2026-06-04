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

import { openDB, type IDBPDatabase } from 'idb';
import type { HighliteSchema } from '../../interfaces/highlite/database/database.schema';

export class DatabaseManager {
    private static instance: DatabaseManager;
    database!: IDBPDatabase<HighliteSchema>;

    constructor() {
        if (DatabaseManager.instance) {
            return DatabaseManager.instance;
        }
        
        if (document.highlite.managers.DatabaseManager) {
            DatabaseManager.instance = document.highlite.managers.DatabaseManager;
            return document.highlite.managers.DatabaseManager;
        }

        DatabaseManager.instance = this;
        document.highlite.managers.DatabaseManager = this;
    }

    async initDB() {
        this.database = await openDB<HighliteSchema>('HighliteDatabase', 4, {
            upgrade(db, oldVersion) {
                if (!db.objectStoreNames.contains('settings')) {
                    db.createObjectStore('settings');
                }
                if (
                    oldVersion < 2 &&
                    !db.objectStoreNames.contains('drop_logs')
                ) {
                    db.createObjectStore('drop_logs');
                }
                if (oldVersion < 3) {
                    db.createObjectStore("data");
                    if (db.objectStoreNames.contains('settings')) {
                        // Clear the settings store if it exists
                        db.deleteObjectStore('settings');
                        db.createObjectStore('settings');
                    }
                }
                if (oldVersion < 4) {
                    db.createObjectStore("plugins");
                }
            },
        });
    }
}
