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

import { ActionState } from '../../interfaces/game/ActionStates.enum';
import { ContextMenuTypes } from '../../interfaces/game/ContextMenuTypes.enum';

export enum EntityType {
    Any = -1,
    WorldObject = 0,
    GroundItem = 1,
    NPC = 2,
    Player = 3,
}

interface ActionInformation {
    actionNumber: number;
    handleFunctions: Function[];
}

interface EntityAction {
    _entity: any;
}

interface GameEntity {
    _entityType: any;
}

export class ContextMenuManager {
    private static instance: ContextMenuManager;
    defaultActions = {};
    inventoryActions = {};
    gameWorldActions = {};
    gameWorldActionsSorting = {};
    inventoryActionsSorting = {};
    spellActions = {};

    constructor() {
        if (ContextMenuManager.instance) {
            return ContextMenuManager.instance;
        }

        if (document.highlite.managers.ContextMenuManager) {
            ContextMenuManager.instance = document.highlite.managers.ContextMenuManager;
            return document.highlite.managers.ContextMenuManager;
        }
        
        ContextMenuManager.instance = this;
        document.highlite.managers.ContextMenuManager = this;
    }

    AddDefaultMenuAction(actionName: string): number {
        return -1;
    }

    AddInventoryItemMenuAction(
        actionName: string,
        handleFunction: Function,
        actionState: ActionState = ActionState.Any,
        contextMenuType: ContextMenuTypes
    ): number {
        const ContextMenuActions = document.highlite.gameLookups['InventoryActions'];

        let actionNumber = -1;
        if (ContextMenuActions[actionName] === undefined) {
            ContextMenuActions[
                (ContextMenuActions[actionName] =
                    Object.keys(ContextMenuActions).length / 2)
            ] = actionName;
            actionNumber = Object.keys(ContextMenuActions).length / 2 - 1;
        } else {
            actionNumber = ContextMenuActions[actionName];
        }

        if (!this.inventoryActions[contextMenuType]) {
            this.inventoryActions[contextMenuType] = {};
        }

        if (!this.inventoryActions[contextMenuType][actionState]) {
            this.inventoryActions[contextMenuType][actionState] = {};
        }

        if (!this.inventoryActions[contextMenuType][actionState][actionName]) {
            this.inventoryActions[contextMenuType][actionState][actionName] = {
                actionNumber: actionNumber,
                handleFunctions: [handleFunction],
            };
        } else {
            this.inventoryActions[contextMenuType][actionState][
                actionName
            ].handleFunctions.push(handleFunction);
        }

        return actionNumber;
    }

    AddGameWorldMenuAction(
        actionName: string,
        handleFunction: Function,
        entityType: EntityType = EntityType.Any
    ): number {
        const ContextMenuActions = document.highlite.gameLookups['GameWorldActions'];

        let actionNumber = -1;
        if (ContextMenuActions[actionName] === undefined) {
            ContextMenuActions[
                (ContextMenuActions[actionName] =
                    Object.keys(ContextMenuActions).length / 2)
            ] = actionName;
            actionNumber = Object.keys(ContextMenuActions).length / 2 - 1;
        } else {
            actionNumber = ContextMenuActions[actionName];
        }

        if (!this.gameWorldActions[entityType]) {
            this.gameWorldActions[entityType] = {};
        }

        if (!this.gameWorldActions[entityType][actionName]) {
            this.gameWorldActions[entityType][actionName] = {
                actionNumber: actionNumber,
                handleFunctions: [handleFunction],
            };
        } else {
            this.gameWorldActions[entityType][actionName].handleFunctions.push(
                handleFunction
            );
        }

        return actionNumber;
    }

    RemoveGameWorldMenuAction(
        actionName: string,
        handleFunction: Function,
        entityType: EntityType = EntityType.Any
    ) {
        if (
            this.gameWorldActions[entityType] &&
            this.gameWorldActions[entityType][actionName]
        ) {
            const actionInfo = this.gameWorldActions[entityType][actionName];
            const index = actionInfo.handleFunctions.indexOf(handleFunction);
            if (index > -1) {
                actionInfo.handleFunctions.splice(index, 1);
            }
        }

        // If no handle functions left, remove the action
        if (
            this.gameWorldActions[entityType] &&
            this.gameWorldActions[entityType][actionName] &&
            this.gameWorldActions[entityType][actionName].handleFunctions
                .length === 0
        ) {
            delete this.gameWorldActions[entityType][actionName];
        }

        if (Object.keys(this.gameWorldActions[entityType]).length === 0) {
            delete this.gameWorldActions[entityType];
        }
        return true;
    }

    RemoveInventoryItemMenuAction(
        actionName: string,
        handleFunction: Function,
        actionState: ActionState = ActionState.Any,
        contextMenuType: ContextMenuTypes
    ) {
        if (
            this.inventoryActions[contextMenuType] &&
            this.inventoryActions[contextMenuType][actionState] &&
            this.inventoryActions[contextMenuType][actionState][actionName]
        ) {
            const actionInfo =
                this.inventoryActions[contextMenuType][actionState][actionName];
            const index = actionInfo.handleFunctions.indexOf(handleFunction);
            if (index > -1) {
                actionInfo.handleFunctions.splice(index, 1);
            }
        }

        // If no handle functions left, remove the action
        if (
            this.inventoryActions[contextMenuType] &&
            this.inventoryActions[contextMenuType][actionState] &&
            this.inventoryActions[contextMenuType][actionState][actionName] &&
            this.inventoryActions[contextMenuType][actionState][actionName]
                .handleFunctions.length === 0
        ) {
            delete this.inventoryActions[contextMenuType][actionState][
                actionName
            ];
        }

        if (
            Object.keys(this.inventoryActions[contextMenuType][actionState])
                .length === 0
        ) {
            delete this.inventoryActions[contextMenuType][actionState];
        }
        return true;
    }

    AddSpellMenuAction(actionName: string): number {
        return -1;
    }

    inventoryContextHook(inputArguments: any, actions: any, aG: any): any {
        const e: any = inputArguments[0];
        const t: any = inputArguments[1];
        const i: any = inputArguments[2];
        const n: any = inputArguments[3];
        const r: any = inputArguments[4];
        const s: any = inputArguments[5];

        let output = actions;

        // Check if this.inventoryActions has key 'r'
        if (this.inventoryActions[r] !== undefined) {
            const contextMenuActionsContextSpecific =
                this.inventoryActions[r][ActionState.Any];
            if (contextMenuActionsContextSpecific) {
                for (const [actionName, actionInformation] of Object.entries(
                    contextMenuActionsContextSpecific
                )) {
                    const actionInfo = actionInformation as ActionInformation;
                    output.push(
                        aG._contextMenuItemFactory.createInventoryItemContextMenuItem(
                            this.inventoryActionHandler.bind(
                                this,
                                r,
                                ActionState.Any
                            ),
                            r,
                            actionInfo.actionNumber,
                            i,
                            n,
                            null,
                            0
                        )
                    );
                }
            }

            const contextMenuActionsContextSpecificActionSpecific =
                this.inventoryActions[r][
                    document.highlite.gameHooks.EntityManager.Instance._mainPlayer._currentState.getCurrentState()
                ];
            if (contextMenuActionsContextSpecificActionSpecific) {
                for (const [actionName, actionInformation] of Object.entries(
                    contextMenuActionsContextSpecificActionSpecific
                )) {
                    const actionInfo = actionInformation as ActionInformation;
                    output.push(
                        aG._contextMenuItemFactory.createInventoryItemContextMenuItem(
                            this.inventoryActionHandler.bind(
                                this,
                                r,
                                document.highlite.gameHooks.EntityManager.Instance._mainPlayer._currentState.getCurrentState()
                            ),
                            r,
                            actionInfo.actionNumber,
                            i,
                            n,
                            null,
                            0
                        )
                    );
                }
            }
        }

        // Check if this.inventoryActions has key 'ContextMenuTypes.Any'
        if (this.inventoryActions[ContextMenuTypes.Any] !== undefined) {
            const contextMenuActions =
                this.inventoryActions[ContextMenuTypes.Any][ActionState.Any];
            if (contextMenuActions) {
                for (const [actionName, actionInformation] of Object.entries(
                    contextMenuActions
                )) {
                    const actionInfo = actionInformation as ActionInformation;
                    output.push(
                        aG._contextMenuItemFactory.createInventoryItemContextMenuItem(
                            this.inventoryActionHandler.bind(
                                this,
                                ContextMenuTypes.Any,
                                ActionState.Any
                            ),
                            r,
                            actionInfo.actionNumber,
                            i,
                            n,
                            null,
                            0
                        )
                    );
                }
            }

            const contextMenuActionsActionSpecific =
                this.inventoryActions[ContextMenuTypes.Any][
                    document.highlite.gameHooks.EntityManager.Instance._mainPlayer._currentState.getCurrentState()
                ];
            if (contextMenuActionsActionSpecific) {
                for (const [actionName, actionInformation] of Object.entries(
                    contextMenuActionsActionSpecific
                )) {
                    const actionInfo = actionInformation as ActionInformation;
                    output.push(
                        aG._contextMenuItemFactory.createInventoryItemContextMenuItem(
                            this.inventoryActionHandler.bind(
                                this,
                                ContextMenuTypes.Any,
                                document.highlite.gameHooks.EntityManager.Instance._mainPlayer._currentState.getCurrentState()
                            ),
                            r,
                            actionInfo.actionNumber,
                            i,
                            n,
                            null,
                            0
                        )
                    );
                }
            }
        }

        output.sort((a, b) => {
            const aActionNumber = a.Action;
            const bActionNumber = b.Action;

            const aPosition =
                this.inventoryActionsSorting[aActionNumber] !== undefined
                    ? this.inventoryActionsSorting[aActionNumber]
                    : output.length;
            const bPosition =
                this.inventoryActionsSorting[bActionNumber] !== undefined
                    ? this.inventoryActionsSorting[bActionNumber]
                    : output.length;

            return aPosition - bPosition;
        });

        return output;
    }

    gameWorldContextHook(e, i, vG): any {
        const cG = e[0];
        const actionsAndEntities = cG._actionsAndEntities;

        // Find 'unique' enities (where actionsAndEntities._entity is unique)
        const uniqueEntities: GameEntity[] = [];
        for (const actionInformation of Object.entries(actionsAndEntities)) {
            const entityAction = actionInformation[1] as EntityAction;
            if (
                entityAction._entity != null &&
                !uniqueEntities.includes(entityAction._entity)
            ) {
                uniqueEntities.push(entityAction._entity);
            }
        }

        let outputs = i;
        // Now we 'create' actions as needed
        for (const entity of uniqueEntities) {
            const contextMenuActionsSpecific =
                this.gameWorldActions[entity._entityType];
            if (contextMenuActionsSpecific) {
                for (const [actionName, actionInfo] of Object.entries(
                    contextMenuActionsSpecific
                )) {
                    const actionData = actionInfo as ActionInformation;
                    // TODO: Figure out if we ever need these nulls
                    outputs.push(
                        vG._contextMenuItemFactory.createGameWorldContextMenuItem(
                            actionData.actionNumber,
                            this.worldObjectActionHandler.bind(
                                this,
                                entity._entityType
                            ),
                            entity,
                            null,
                            null,
                            null
                        )
                    );
                }
            }

            // EntityType.Any
            const contextMenuActionsAny = this.gameWorldActions[EntityType.Any];
            if (contextMenuActionsAny) {
                for (const [actionName, actionInfo] of Object.entries(
                    contextMenuActionsAny
                )) {
                    const actionData = actionInfo as ActionInformation;
                    // TODO: Figure out if we ever need these nulls
                    outputs.push(
                        vG._contextMenuItemFactory.createGameWorldContextMenuItem(
                            actionData.actionNumber,
                            this.worldObjectActionHandler.bind(
                                this,
                                EntityType.Any
                            ),
                            entity,
                            null,
                            null,
                            null
                        )
                    );
                }
            }
        }

        // Output is an array of ContextMenuItems, a ContextMenuItem has a property called Action which is the actionNumber
        // Based on the actionNumber, if we can find it in the gameWorldSorting, we need to place it in the correct position
        // In some cases, we expect that the position may exceed the length of the array, in that case we need to place it at the end of the array

        return outputs;
    }

    inventoryActionHandler(contextType, actionState, e, i: any) {
        let actionNumber = e.getItemAction();

        const inventoryActions =
            this.inventoryActions[contextType][actionState];
        if (inventoryActions) {
            for (const [actionName, actionInformation] of Object.entries(
                inventoryActions
            )) {
                const actionInfo = actionInformation as ActionInformation;
                if (actionInfo.actionNumber == actionNumber) {
                    for (const handleFunction of actionInfo.handleFunctions) {
                        handleFunction(e, i);
                    }
                }
            }
        }
    }

    worldObjectActionHandler(entityType, e, i) {
        // Loop over all the EntityTypes to find the actionNumber
        const entityActions = this.gameWorldActions[entityType];
        if (entityActions) {
            for (const [actionName, actionInformation] of Object.entries(
                entityActions
            )) {
                const actionInfo = actionInformation as ActionInformation;
                if (actionInfo.actionNumber == e.Action) {
                    for (const handleFunction of actionInfo.handleFunctions) {
                        handleFunction(e, i);
                    }
                }
            }
        }
    }

    SetGameWorldActionMenuPosition(actionName: string, position: number) {
        //ActionName should be converted to all lowercase and spaces replace with _s
        let lookupName = actionName.toLowerCase().replace(/ /g, '_');

        const ContextMenuActions = document.highlite.gameLookups['GameWorldActions'];
        if (ContextMenuActions[lookupName] !== undefined) {
            this.gameWorldActionsSorting[ContextMenuActions[lookupName]] =
                position;
        }
    }

    RemoveGameWorldActionMenuPosition(actionName: string) {
        //ActionName should be converted to all lowercase and spaces replace with _s
        let lookupName = actionName.toLowerCase().replace(/ /g, '_');

        const ContextMenuActions = document.highlite.gameLookups['GameWorldActions'];
        if (ContextMenuActions[lookupName] !== undefined) {
            delete this.gameWorldActionsSorting[ContextMenuActions[lookupName]];
        }
    }

    SetInventoryActionMenuPosition(actionName: string, position: number) {
        const ContextMenuActions = document.highlite.gameLookups['InventoryActions'];
        if (ContextMenuActions[actionName] !== undefined) {
            this.inventoryActionsSorting[ContextMenuActions[actionName]] =
                position;
        }
    }

    RemoveInventoryActionMenuPosition(actionName: string) {
        const ContextMenuActions = document.highlite.gameLookups['InventoryActions'];
        if (ContextMenuActions[actionName] !== undefined) {
            delete this.inventoryActionsSorting[ContextMenuActions[actionName]];
        }
    }

    registerContextHook(
        sourceClass: string,
        fnName: string,
        hookFn: Function
    ): boolean {
        const self = this;
        const targetClass = document.highlite.gameHooks[sourceClass];
        if (!targetClass) {
            console.warn(`[EvilLite] Class ${sourceClass} not found in game hooks.`);
            return false;
        }

        const classObject = targetClass.prototype;
        if (!classObject) {
            console.warn(`[EvilLite] Attempted to register unknown client class context hook (${sourceClass}).`);
            return false;
        }

        (function (originalFunction: any) {
            classObject[fnName] = function (...args: Array<unknown>) {
                const originalReturn = originalFunction.apply(this, arguments);
                return hookFn.apply(self, [args, originalReturn, this]);
            };
        })(classObject[fnName]);

        return true;
    }

    public registerStaticContextHook(
        sourceClass: string,
        fnName: string,
        hookFn = Function
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

    ActionSorting(e, t, i, j, dG) {
        const contextMenuManager: ContextMenuManager = new ContextMenuManager();
        if (
            !dG ||
            !dG._mousePointActionsAndEntitiesResult ||
            !dG._mousePointActionsAndEntitiesResult._actionsAndEntities
        ) {
            return;
        }

        dG._mousePointActionsAndEntitiesResult._actionsAndEntities.sort(
            (a, b) => {
                const aActionNumber = a.Action;
                const bActionNumber = b.Action;

                // Get current position of the action
                const currentPositionA =
                    dG._mousePointActionsAndEntitiesResult._actionsAndEntities.indexOf(
                        a
                    );
                const currentPositionB =
                    dG._mousePointActionsAndEntitiesResult._actionsAndEntities.indexOf(
                        b
                    );

                const aPosition =
                    contextMenuManager.gameWorldActionsSorting[
                        aActionNumber
                    ] !== undefined
                        ? contextMenuManager.gameWorldActionsSorting[
                              aActionNumber
                          ]
                        : currentPositionA;
                const bPosition =
                    contextMenuManager.gameWorldActionsSorting[
                        bActionNumber
                    ] !== undefined
                        ? contextMenuManager.gameWorldActionsSorting[
                              bActionNumber
                          ]
                        : currentPositionB;

                return aPosition - bPosition;
            }
        );

        dG._mousePointActionsAndEntitiesResult._mainActionAndEntity =
            dG._mousePointActionsAndEntitiesResult._actionsAndEntities[0];
    }
}
