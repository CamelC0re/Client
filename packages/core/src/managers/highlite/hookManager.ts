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

export class HookManager {
    private static instance: HookManager;

    constructor() {
        if (HookManager.instance) {
            return HookManager.instance;
        }

        if (document.highlite.managers.HookManager) {
            HookManager.instance = document.highlite.managers.HookManager;
            return document.highlite.managers.HookManager;
        }

        HookManager.instance = this;
        document.highlite.managers.HookManager = this;
    }

    public registerClass(className: string, mappedName: string): boolean {
        const classInstance = document.client.get(className);

        if (!classInstance) {
            console.warn(
                `[Ryelite] ${className} (${mappedName}) is not defined in client.`
            );
            return false;
        }

        document.highlite.gameHooks[mappedName] = classInstance;

        const classPrototype = classInstance.prototype;


        const prototypeMethods = Object.entries(Object.getOwnPropertyDescriptors(classPrototype))
            .filter(([name, desc]) =>
                typeof desc.value === 'function' &&
                name !== 'constructor'
            )
            .map(([name]) => name);

        const staticMethods = Object.entries(Object.getOwnPropertyDescriptors(classInstance))
            .filter(([name, desc]) =>
                typeof desc.value === 'function' &&
                !['length', 'name', 'prototype'].includes(name)
            )
            .map(([name]) => name);

        for (const fnName in prototypeMethods) {
            this.registerClassHook(mappedName, prototypeMethods[fnName]);
        }

        for (const staticMethod in staticMethods) {
            this.registerStaticClassHook(mappedName, staticMethods[staticMethod])
        }

        return true;
    }

    public registerEnum(enumName: string, mappedName: string): boolean {
        const enumInstance = document.client.get(enumName);

        if (!enumInstance) {
            console.warn(
                `[Ryelite] ${enumName} (${mappedName}) is not defined in client.`
            );
            return false;
        }

        document.highlite.gameLookups[mappedName] = enumInstance;
        return true;
    }

    public registerClassHook(
        sourceClass: string,
        fnName: string,
        hookFn = this.hook
    ): boolean {
        const self = this;
        const targetClass = document.highlite.gameHooks[sourceClass];
        if (!targetClass) {
            console.warn(`[EvilLite] Class ${sourceClass} not found in game hooks.`);
            return false;
        }

        const classObject = targetClass.prototype;
        if (!classObject) {
            console.warn(
                `[EvilLite] Attempted to register unknown client class hook (${sourceClass}).`
            );
            return false;
        }

        let functionName = fnName;
        if (functionName.startsWith('_')) {
            functionName = functionName.substring(1);
        }

        const hookName = `${sourceClass}_${functionName}`;
        (function (originalFunction: any) {
            classObject[fnName] = function (...args: Array<unknown>) {
                const originalReturn = originalFunction.apply(this, arguments);
                hookFn.apply(self, [hookName, ...args, this]);
                return originalReturn;
            };
        })(classObject[fnName]);

        return true;
    }

    public registerClassOverrideHook(
        sourceClass: string,
        fnName: string,
        hookFn = this.hook
    ): boolean {
        const self = this;
        const targetClass = document.highlite.gameHooks[sourceClass];
        if (!targetClass) {
            console.warn(`[EvilLite] Class ${sourceClass} not found in game hooks.`);
            return false;
        }

        const classObject = targetClass.prototype;
        if (!classObject) {
            console.warn(
                `[EvilLite] Attempted to register unknown client class override hook (${sourceClass}).`
            );
            return false;
        }

        let functionName = fnName;
        if (functionName.startsWith('_')) {
            functionName = functionName.substring(1);
        }

        const hookName = `${sourceClass}_${functionName}`;
        (function (originalFunction: any) {
            classObject[fnName] = function (...args: Array<unknown>) {
                return hookFn.apply(self, [hookName, ...args, this]);
            };
        })(classObject[fnName]);
        return true;
    }

    public registerStaticClassHook(
        sourceClass: string,
        fnName: string,
        hookFn = this.hook
    ): boolean {
        const self = this;
        const classObject = document.highlite.gameHooks[sourceClass];

        if (!classObject) {
            console.warn(
                `[EvilLite] Attempted to register unknown static client class hook (${sourceClass}).`
            );
            return false;
        }

        let functionName = fnName;
        if (functionName.startsWith('_')) {
            functionName = functionName.substring(1);
        }

        const hookName = `${sourceClass}_${functionName}`;
        (function (originalFunction: any) {
            classObject[fnName] = function (...args: Array<unknown>) {
                const returnValue = originalFunction.apply(this, arguments);
                hookFn.apply(self, [hookName, ...args, this]);
                return returnValue;
            };
        })(classObject[fnName]);
        return true;
    }

    private hook(fnName: string, ...args: any[]): void {
        if (!document.highlite.managers.PluginManager) {
            console.warn(`[Ryelite] Plugin Manager not initialized.`);
            return;
        }
        for (const plugin of document.highlite.managers.PluginManager.plugins) {
            if (!plugin.instance) {
                continue;
            }
            if (typeof plugin.instance[fnName] === 'function') {
                try {
                    if (plugin.instance.settings.enable.value) {
                        plugin.instance[fnName].apply(plugin.instance, args);
                    }
                } catch (error) {
                    console.error(
                        `[Ryelite] Error in plugin ${plugin.instance?.pluginName} (${fnName}):`,
                        error
                    );
                }
            }
        }
    }
}
