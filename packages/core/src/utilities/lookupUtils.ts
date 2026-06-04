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

export function getSkillName(skillId: number): string {
    try {
        return (
            document.highlite.gameLookups.Skills[skillId] || `Skill ${skillId}`
        );
    } catch {
        return `Skill ${skillId}`;
    }
}

export function getEquipmentTypeName(typeId: number): string {
    try {
        const types = ['helmet', 'chest', 'legs', 'shield', 'weapon', 'back', 'neck', 'gloves', 'boots', 'projectile'];
        return (
            types[typeId] ||
            `Type ${typeId}`
        );
    } catch {
        return `Type ${typeId}`;
    }
}
