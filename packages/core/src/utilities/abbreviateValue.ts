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

export function abbreviateValue(number: number): string {
    // Values less than 1000 are returned as is
    if (number < 1000) {
        return number.toString();
    }

    // Values between 1000 and 999,999 are abbreviated with 'K'
    if (number < 1000000) {
        return (number / 1000).toFixed(1) + 'K';
    }

    // Values between 1,000,000 and 999,999,999 are abbreviated with 'M'
    if (number < 1000000000) {
        return (number / 1000000).toFixed(2) + 'M';
    }

    // Values between 1,000,000,000 and 999,999,999,999 are abbreviated with 'B'
    if (number < 1000000000000) {
        return (number / 1000000000).toFixed(3) + 'B';
    }

    // Values 1 trillion and above are abbreviated with 'T'
    return (number / 1000000000000).toFixed(4) + 'T';
}
