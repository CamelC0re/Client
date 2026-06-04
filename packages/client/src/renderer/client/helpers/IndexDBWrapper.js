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

export class IndexDBWrapper {
    dbName = 'Ryelite';
    storeName = 'Resources';
    db;
    initialized = false;
    constructor() {
        this.db = null;
    }
    async init() {
        const openRequest = window.indexedDB.open(this.dbName);
        return new Promise((resolve, reject) => {
            openRequest.onsuccess = event => {
                this.db = event.target.result;
                console.debug(
                    `[Ryelite Loader] IndexDB ${this.dbName} opened successfully.`
                );
                this.initialized = true;
                resolve(true);
            };
            openRequest.onerror = event => {
                console.error(
                    `[Ryelite Loader] IndexDB ${this.dbName} could not be opened.`
                );
                reject(false);
            };
            openRequest.onupgradeneeded = event => {
                this.db = event.target.result;
                console.debug(
                    `[Ryelite Loader] IndexDB ${this.dbName} was created.`
                );
                if (this.db) {
                    this.db.createObjectStore(this.storeName);
                    console.debug(
                        `[Ryelite Loader] IndexDB Object Store ${this.storeName} was created.`
                    );
                }
            };
        });
    }
    setItem(keyName, value) {
        if (!this.initialized) {
            console.warn(
                '[Ryelite Loader] Attempted to setItem before the database was initialized'
            );
            return Promise.resolve(false);
        }
        if (this.db == null) {
            console.warn(
                `[Ryelite Loader] Attempted to setItem on a 'null' database`
            );
            return Promise.resolve(false);
        }
        if (!this.db.objectStoreNames.contains(this.storeName)) {
            console.error(
                `[Ryelite Loader] Object store ${this.storeName} does not exist.`
            );
        }
        const transaction = this.db.transaction(this.storeName, 'readwrite');
        transaction.oncomplete = event => {
            console.debug(
                `[Ryelite Loader] setItem transaction request succeeded`
            );
        };
        transaction.onerror = event => {
            console.warn(
                `[Ryelite Loader] setItem transaction request failed on ${this.storeName}`
            );
            return Promise.resolve(false);
        };
        const objectStore = transaction.objectStore(this.storeName);
        const setRequest = objectStore.put(value, keyName);
        return new Promise((resolve, reject) => {
            setRequest.onsuccess = event => {
                console.debug(
                    `[Ryelite Loader] setItem set Key: ${keyName} to Value: ${value}`
                );
                resolve(true);
            };
            setRequest.onerror = event => {
                console.warn(
                    `[Ryelite Loader] setItem could not set Key: ${keyName} to Value: ${value}`
                );
                resolve(false);
            };
        });
    }
    getItem(keyName) {
        if (!this.initialized) {
            console.warn(
                '[Ryelite Loader] Attempted to getItem before the database was initialized'
            );
            return Promise.resolve(null);
        }
        if (this.db == null) {
            console.warn(
                `[Ryelite Loader] Attempted to getItem on a 'null' database`
            );
            return Promise.resolve(null);
        }
        if (!this.db.objectStoreNames.contains(this.storeName)) {
            console.error(
                `[Ryelite Loader] Object store ${this.storeName} does not exist.`
            );
        }
        const transaction = this.db.transaction(this.storeName, 'readonly');
        transaction.oncomplete = event => {
            console.debug(
                `[Ryelite Loader] getItem transaction request succeeded`
            );
        };
        transaction.onerror = event => {
            console.warn(
                `[Ryelite Loader] getItem transaction request failed on ${this.storeName}`
            );
        };
        const objectStore = transaction.objectStore(this.storeName);
        const getRequest = objectStore.get(keyName);
        return new Promise((resolve, reject) => {
            getRequest.onsuccess = event => {
                console.debug(
                    `[Ryelite Loader] getItem retrieved Key: ${keyName} with Value: ${getRequest.result}`
                );
                resolve(getRequest.result);
            };
            getRequest.onerror = event => {
                console.warn(
                    `[Ryelite Loader] getItem could not retrieve Key: ${keyName}`
                );
                resolve(null);
            };
        });
    }
}
