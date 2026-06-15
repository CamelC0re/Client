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

// Resolve the logged-in username used to key per-user settings and plugin data.
// EvilQuest exposes it on GameManager (gm.username); upstream HighSpell put it on
// EntityManager.Instance._mainPlayer. Try both, then fall back so init never throws
// (an un-keyed 'default' bucket is better than crashing every plugin/setting).
export function resolveUsername(): string {
    const hooks = (document as any)?.highlite?.gameHooks ?? {};

    const gmName = hooks.GameManager?.Instance?.username;
    if (typeof gmName === 'string' && gmName) return gmName.toLowerCase();

    const emName = hooks.EntityManager?.Instance?._mainPlayer?._nameLowerCase;
    if (typeof emName === 'string' && emName) return emName;

    console.warn('[EvilLite] could not resolve username — using "default" bucket');
    return 'default';
}
