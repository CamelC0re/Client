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

import { TooltipConfig } from '../../interfaces/highlite/plugin/TooltipConfig.interface';
import { defaultTooltipConfig, ItemTooltip } from './itemTooltip';

export enum UIManagerScope {
    ClientRelative,
    ClientInternal,
    ClientOverlay,
}

export class UIManager {
    private static instance: UIManager;
    private itemTooltip: ItemTooltip | null = null;

    constructor() {
        if (UIManager.instance) {
            return UIManager.instance;
        }

        if (document.highlite.managers.UIManager) {
            UIManager.instance = document.highlite.managers.UIManager;
            return document.highlite.managers.UIManager;
        }

        UIManager.instance = this;
        document.highlite.managers.UIManager = this;
    }

    private preventDefault(e: Event) {
        e.preventDefault();
        e.stopPropagation();
    }

    bindOnClickBlockHsMask(element: HTMLElement, callback: (e: Event) => void) {
        element.addEventListener('click', e => {
            callback(e);
            this.preventDefault(e);
        });
        element.addEventListener('pointerdown', this.preventDefault);
        element.addEventListener('pointerup', this.preventDefault);
    }

    // Create Element
    createElement(scope: UIManagerScope): HTMLElement {
        const element = document.createElement('div');
        element.classList.add('highlite-ui');
        switch (scope) {
            case UIManagerScope.ClientRelative:
                element.classList.add('highlite-ui-client-relative');

                element.addEventListener('keydown', e => {
                    e.stopPropagation();
                });
                element.addEventListener('keyup', e => {
                    e.stopPropagation();
                });
                element.addEventListener('keyup', e => {
                    e.stopPropagation();
                });
                element.addEventListener('keypress', e => {
                    e.stopPropagation();
                });

                document.getElementById('main')?.appendChild(element);
                break;
            case UIManagerScope.ClientInternal:
                element.classList.add('highlite-ui-client-internal');
                if (!document.getElementById('hs-screen-mask')) {
                    throw new Error(
                        'Ryelite UI Manager: #hs-screen-mask not found'
                    );
                } else {
                    document
                        .getElementById('hs-screen-mask')
                        ?.appendChild(element);
                }
                break;
            case UIManagerScope.ClientOverlay:
                element.classList.add('highlite-ui-client-overlay');
                document.body?.appendChild(element);
                break;
        }
        return element;
    }

    private ensureItemTooltip() {
        // Check if tooltip exists AND is still attached to the DOM
        if (this.itemTooltip && this.itemTooltip.isAttached()) {
            return;
        }

        // Create new tooltip instance
        const screenMask = document.getElementById('hs-screen-mask');
        const container = screenMask || document.body;
        this.itemTooltip = new ItemTooltip(container);
    }

    /**
     * Draw an item tooltip at the specified coordinates
     * @param itemId - The item ID to display tooltip for
     * @param x - X coordinate (in pixels)
     * @param y - Y coordinate (in pixels)
     * @returns Object with hide() method to close the tooltip
     */
    drawItemTooltip(
        itemId: number,
        x: number,
        y: number,
        tooltipConfig: TooltipConfig = defaultTooltipConfig
    ): { hide: () => void } {
        this.ensureItemTooltip();

        if (!this.itemTooltip) {
            return { hide: () => {} };
        }

        return this.itemTooltip.show(itemId, x, y, tooltipConfig);
    }

    /**
     * Hide any currently visible item tooltip
     */
    hideItemTooltip(): void {
        if (this.itemTooltip) {
            this.itemTooltip.hide();
        }
    }

    /**
     * Get the currently displayed item tooltip ID
     */
    getCurrentItemTooltipId(): number | null {
        return this.itemTooltip?.getCurrentItemId() || null;
    }
}
