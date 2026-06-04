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

import { ClassSignature, EnumSignature } from './types';

// Define the map of all class hook signatures
export const ClassSignatures: [string, ClassSignature][] = [

    // Define all the class signatures
    ['EntityManager', { methods: ['CurrentOnlinePlayerCount', 'NPCs'] }],
    ['GroundItemManager', { methods: ['GroundItemCount'] }],
    ['MeshManager', { methods: ['getInstanceCountForMeshByFileName'] }],
    ['WorldMapManager', { methods: ['NextWorldEntityTypeID'] }],
    ['AtmosphereManager', { methods: ['_initializeEarthOverworldAtmosphere'] }],
    ['WorldEntityManager', { methods: ['WorldEntities'] }],
    ['SpellManager', { methods: ['CurrentlySelectedSpell'] }],
    ['SpellMeshManager', { methods: ['PendingMainPlayerTeleportEndSpellMesh'] }],
    ['GameLoop', { methods: ['startGameLoop'] }],
    ['ChatManager', { methods: ['Friends', 'LastPrivateMessageReceivedFrom'] }],
    ['RangeManager', { methods: ['handleEntityFiredProjectile'] }],
    ['SocketManager', { methods: ['openSocketConnection', 'emitPacket'] }],
    ['GameEngine', { methods: ['Scene', 'Engine', 'Canvas'] }],
    ['ItemManager', { methods: ['CurrentSelectedItem', 'IsItemCurrentlySelected'] }],
    ['LoginScreen', { methods: ['_createControl', '_createLoginMenu'] }],
    ['PrivateChatMessageList', { methods: ['getElement', 'getChatMessages'] }],
    ['InventoryManager', { methods: ['Items', 'IsWaitingForSwapItemConfirmation'] }],
    ['UIManager', { methods: ['Manager'] }],
    ['BankUIManager', { methods: ['_initializeBankMenu'] }],
    ['NameplateManager', { methods: ['getTextColorClassNameForEntityType'] }],
    ['InventoryItemSpriteManager', { methods: ['getSlot', 'getElement', 'updateAmountText'] }],
    ['SpriteSheetManager', { methods: ['ItemSpritesheetInfo'] }],
    ['GameCameraManager', { methods: ['initializeCamera'] }],
    ['ItemDefinitionManager', { methods: ['loadFromJSON', 'getDefById'], contains: '_itemDefMap' }],
    ['NpcDefinitionManager', { methods: ['loadFromJSON', 'getDefById'], contains: '_npcDefMap' }],
    ['SpellDefinitionManager', { methods: ['loadFromJSON', 'getDefById'], contains: 'SpellDefs' }],
    ['AppearanceUtils', { methods: ['updateAppearance', 'doesAppearanceAndEquippedItemsMatch'] }],
    ['BlobLoader', { methods: ['SizeBytes', 'createObjectURL'] }],
    ['HTMLUIManager', { methods: ['getGameContainer'] }],
    ['ScreenMask', { methods: ['getForceDesktopModeControl'] }],
    ['ContextMenuManager', { methods: ['createContextMenu', 'createContextMenuItem'] }],
    ['ContextMenuItemManager', { methods: ['_createInventoryItemContextMenuItems', '_createGameWorldContextMenuItems'] }],
    ['TargetActionManager', { methods: ['getActionsAndEntitiesAtMousePointer'] }],
    ['MagicSkillManager', { methods: ['canCastSpellAtLevel'] }],
    ['SpellMenuManager', { methods: ['_handleAutoCastChanged', '_handlePendingSpellChanged'] }],
    ['QuestDefinitionManager', { methods: ['loadFromJSON', 'getDefById'], contains: 'QuestDefs' }],
    ['StatsMenuManager', { methods: ['_handleStatItemPointerOver', '_handleStatItemPointerOut']}],
    ['GameMenuBarManager', { methods: ['_handleGameMenuBarButtonPointerDown', '_toggleGameMenuBarButton']}],
    ['ExperienceManager', { methods: ['getExperienceAtLevel', 'getLevelAtExperience']}]
];

// Define the map of all class hook signatures
export const EnumSignatures: [string, EnumSignature][] = [
    
    // Define all the statement signatures
    ['GameWorldActions', { includes: ['attack', 'talk_to'] }],
    ['InventoryActions',  { includes: ['use', 'inspect', 'drop'] }],
    ['PlayerActions', { includes: ['IdleState', 'MovingState'] }],
    ['Skills', { includes: ['hitpoints', 'accuracy'] }],
    ['EntityTypes', { includes: ['Environment', 'Item'] }],
    ['AppearanceTypes', { includes: ['HairID', 'BeardID', 'ShirtID'], excludes: ['Username']}],
    ['UISettings', { includes: ['UITheme', 'IsGameWindowFullScreen'] }],
    ['GameInterfaces', { includes: ['Inventory', 'Bank', 'Shop'] } ],
    ['GameObjects', { includes: ['caveentrance', 'caveexit', 'oaktree'] }],
    ['RequirementTypes', { includes: ['availableinventoryspace', 'equippeditem', 'quest', 'skill'] }],
    ['SpellTypes', { includes: ['combat', 'status', 'inventory', 'teleport'] }],
];
