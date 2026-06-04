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

// Define a lightweight wrapper around a single IndexedDB object store
export class HighliteResources {

    // Define the database name
    private readonly dbName: string = 'Highlite';

    // Define the object store name
    private readonly storeName: string = 'Resources';

    // Define the database handle
    private db: IDBDatabase | null = null;

    // Define the initialisation flag
    private initialized: boolean = false;

    // Construct the wrapper
    constructor() {}

    // Initialise the database 
    async init(): Promise<boolean> {

        // Return early if already initialised
        if (this.initialized && this.db) {
            return true;
        }

        // Open the database
        const openRequest = window.indexedDB.open(this.dbName);

        // Return a promise representing initialisation
        return new Promise<boolean>((resolve) => {

            // Handle success
            openRequest.onsuccess = (event: Event) => {
                const target = event.target as IDBOpenDBRequest;
                this.db = target.result;
                console.debug(`[Ryelite Loader] IndexDB ${this.dbName} opened successfully.`);
                this.initialized = true;
                resolve(true);
            };

            // Handle failure
            openRequest.onerror = () => {
                console.error(`[Ryelite Loader] IndexDB ${this.dbName} could not be opened.`);
                this.db = null;
                this.initialized = false;
                resolve(false);
            };

            // Handle upgrade (first creation or version bump)
            openRequest.onupgradeneeded = (event: IDBVersionChangeEvent) => {
                const target = event.target as IDBOpenDBRequest;
                this.db = target.result;
                console.debug(`[Ryelite Loader] IndexDB ${this.dbName} was created.`);
                if (this.db && !this.db.objectStoreNames.contains(this.storeName)) {
                    this.db.createObjectStore(this.storeName);
                    console.debug(`[Ryelite Loader] IndexDB Object Store ${this.storeName} was created.`);
                }
            };
        });
    }

    // Set (or overwrite) an item in the object store
    async setItem<T = unknown>(keyName: string, value: T): Promise<boolean> {

        // Guard: initialisation not complete
        if (!this.initialized) {
            console.warn('[Ryelite Loader] Attempted to setItem before the database was initialized');
            return false;
        }

        // Guard: database is null
        if (!this.db) {
            console.warn(`[Ryelite Loader] Attempted to setItem on a 'null' database`);
            return false;
        }

        // Guard: object store missing
        if (!this.db.objectStoreNames.contains(this.storeName)) {
            console.error(`[Ryelite Loader] Object store ${this.storeName} does not exist.`);
            return false;
        }

        // Open a readwrite transaction
        const transaction = this.db.transaction(this.storeName, 'readwrite');

        // Debug success / failure of transaction (optional)
        transaction.oncomplete = () => {
            console.debug(`[Ryelite Loader] setItem transaction request succeeded`);
        };
        transaction.onerror = () => {
            console.warn(`[Ryelite Loader] setItem transaction request failed on ${this.storeName}`);
        };

        // Get the object store
        const objectStore = transaction.objectStore(this.storeName);

        // Issue the put request (upsert)
        const setRequest = objectStore.put(value as unknown as IDBValidKey extends never ? never : any, keyName);

        // Return a promise representing completion
        return new Promise<boolean>((resolve) => {
            setRequest.onsuccess = () => {
                console.debug(`[Ryelite Loader] setItem set Key: ${keyName} to Value (type): ${typeof value}`);
                resolve(true);
            };
            setRequest.onerror = () => {
                console.warn(`[Ryelite Loader] setItem could not set Key: ${keyName}`);
                resolve(false);
            };
        });
    }

    // Get a stored item by key
    async getItem<T = unknown>(keyName: string): Promise<T | null> {

        // Guard: initialisation not complete
        if (!this.initialized) {
            console.warn('[Ryelite Loader] Attempted to getItem before the database was initialized');
            return null;
        }

        // Guard: database is null
        if (!this.db) {
            console.warn(`[Ryelite Loader] Attempted to getItem on a 'null' database`);
            return null;
        }

        // Guard: object store missing
        if (!this.db.objectStoreNames.contains(this.storeName)) {
            console.error(`[Ryelite Loader] Object store ${this.storeName} does not exist.`);
            return null;
        }

        // Open a readonly transaction
        const transaction = this.db.transaction(this.storeName, 'readonly');

        transaction.oncomplete = () => {
            console.debug(`[Ryelite Loader] getItem transaction request succeeded`);
        };
        transaction.onerror = () => {
            console.warn(`[Ryelite Loader] getItem transaction request failed on ${this.storeName}`);
        };

        // Lookup the key
        const objectStore = transaction.objectStore(this.storeName);
        const getRequest = objectStore.get(keyName);

        // Return a promise for the retrieval
        return new Promise<T | null>((resolve) => {
            getRequest.onsuccess = () => {
                console.debug(
                    `[Ryelite Loader] getItem retrieved Key: ${keyName} with Value (type): ${typeof getRequest.result}`
                );
                resolve(getRequest.result as T ?? null);
            };
            getRequest.onerror = () => {
                console.warn(`[Ryelite Loader] getItem could not retrieve Key: ${keyName}`);
                resolve(null);
            };
        });
    }

    // Delete a single key
    async deleteItem(keyName: string): Promise<boolean> {

        if (!this.initialized || !this.db) {
            console.warn('[Ryelite Loader] Attempted to deleteItem before database was ready');
            return false;
        }
        if (!this.db.objectStoreNames.contains(this.storeName)) {
            console.error(`[Ryelite Loader] Object store ${this.storeName} does not exist.`);
            return false;
        }

        const tx = this.db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const delReq = store.delete(keyName);

        return new Promise<boolean>((resolve) => {
            delReq.onsuccess = () => {
                console.debug(`[Ryelite Loader] deleteItem removed Key: ${keyName}`);
                resolve(true);
            };
            delReq.onerror = () => {
                console.warn(`[Ryelite Loader] deleteItem failed for Key: ${keyName}`);
                resolve(false);
            };
        });
    }

    // Clear the entire store
    async clear(): Promise<boolean> {
        if (!this.initialized || !this.db) {
            console.warn('[Ryelite Loader] Attempted to clear before database was ready');
            return false;
        }
        if (!this.db.objectStoreNames.contains(this.storeName)) {
            console.error(`[Ryelite Loader] Object store ${this.storeName} does not exist.`);
            return false;
        }
        const tx = this.db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const clearReq = store.clear();
        return new Promise<boolean>((resolve) => {
            clearReq.onsuccess = () => {
                console.debug(`[Ryelite Loader] clear removed all keys in ${this.storeName}`);
                resolve(true);
            };
            clearReq.onerror = () => {
                console.warn(`[Ryelite Loader] clear failed on ${this.storeName}`);
                resolve(false);
            };
        });
    }

    // Close the database
    close(): void {
        if (this.db) {
            this.db.close();
            this.db = null;
            this.initialized = false;
            console.debug(`[Ryelite Loader] IndexDB ${this.dbName} was closed.`);
        }
    }
}
