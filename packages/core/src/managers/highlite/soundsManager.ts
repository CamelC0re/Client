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

export class SoundManager {
    private static instance: SoundManager;

    currentlyPlaying: {
        [key: string]: HTMLAudioElement;
    } = {};

    constructor() {
        if (SoundManager.instance) {
            return SoundManager.instance;
        }

        if (document.highlite.managers.SoundManager) {
            SoundManager.instance = document.highlite.managers.SoundManager;
            return document.highlite.managers.SoundManager;
        }

        SoundManager.instance = this;
        document.highlite.managers.SoundManager = this;
    }

    playSound(resource: string, volume: number = 1) {
        if (!this.currentlyPlaying[resource]) {
            const audio = this.createAudioElement(resource, volume);
            audio.play();
        }
    }

    createAudioElement(resource: string, volume: number = 1): HTMLAudioElement {
        const audio = new Audio(resource);
        audio.volume = volume;
        audio.play();
        audio.onended = () => {
            this.currentlyPlaying[resource]?.remove();
            delete this.currentlyPlaying[resource];
        };
        this.currentlyPlaying[resource] = audio;
        return audio;
    }
}
