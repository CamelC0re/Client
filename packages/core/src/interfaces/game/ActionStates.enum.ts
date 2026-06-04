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

export enum ActionState {
    Any = -1,
    IdleState = 0,
    MovingState = 1,
    MovingTowardTargetState = 2,
    BankingState = 3,
    MeleeCombatState = 4,
    TradingState = 5,
    ShoppingState = 6,
    FishingState = 7,
    CookingState = 8,
    RespawningState = 9,
    PlayerDeadState = 10,
    ConversationState = 11,
    ChangingAppearanceState = 12,
    WoodcuttingState = 13,
    MiningState = 14,
    HarvestingState = 15,
    TreeShakingState = 16,
    SmeltingState = 17,
    SmithingState = 18,
    CraftingState = 19,
    GoThroughDoorState = 20,
    MagicCombatState = 21,
    RangeCombatState = 22,
    EnchantingState = 23,
    TeleportingState = 24,
    NPCDeadState = 25,
    CreatingNonSkillItemsState = 26,
    SearchingWorldEntityState = 27,
    PotionMakingState = 28,
    MineThroughRocksState = 29,
    UsingSpinningWheelState = 30,
    ClimbSameMapLevelState = 31,
    SmeltingKilnState = 32,
    PlayerLoggingOutState = 33,
    PickpocketingState = 34,
    StunnedState = 35,
    PicklockingState = 36,
    NPCConversationState = 37,
    RubbingItemState = 38,
    OpeningItemState = 39,
    UsingItemOnEntityState = 40,
    DiggingState = 41,
}
