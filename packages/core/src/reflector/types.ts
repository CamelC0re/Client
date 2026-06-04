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

// Class information for a declared class
export interface ClassInfo {
    name : string;
    staticFields : string[];
    instanceFields : string[];
    staticMethods : {
        name: string;
        kind: string
    }[];
    instanceMethods : {
        name: string;
        kind: string
    }[];
    start : number,
    end : number
}

// Search criteria for mapping a class
export interface ClassSignature {
    fields?: string[];
    methods?: string[];
    contains?: string;
}

//  Search criteria for mapping an enum
export interface EnumInfo {
    name: string,
    members: string[],
    start:  number,
    end: number
}

// Enum information for a declared enum
export interface EnumSignature {
    includes: string[],
    excludes?: string[]
}

// Define a mapping between hook logical names and their obfuscated runtime identifiers
export type HookMap = Map<string, string>;

// Define the serialized representation of a HookMap (for IndexedDB storage)
export type HookEntries = [string, string][];