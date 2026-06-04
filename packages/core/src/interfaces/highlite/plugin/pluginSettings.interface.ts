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

export enum SettingsTypes {
    checkbox,
    range,
    color,
    text,
    button,
    combobox,
    textarea,
    alert,
    warning,
    info,
}

interface BaseSettings<T> {
    text: string;
    description?: string; // Optional description used for the hover title of the setting
    type: SettingsTypes;
    value: T;
    callback: Function;
    validation?: (value: T) => boolean;
    hidden?: boolean;
    disabled?: boolean;
    onLoaded?: Function; // Optional callback called when this setting is loaded from storage
}

interface RangeSettings extends BaseSettings<number> {
    type: SettingsTypes.range;
    min: number;
    max: number;
}

interface ComboBoxSettings extends BaseSettings<string> {
    type: SettingsTypes.combobox;
    options: string[]; // Array of strings used to fill the combobox
}

interface CheckboxSettings extends BaseSettings<boolean> {
    type: SettingsTypes.checkbox;
}

interface ButtonSettings extends BaseSettings<string> {
    type: SettingsTypes.button;
}

interface TextSettings extends BaseSettings<string> {
    type: SettingsTypes.text;
}
interface ColorSettings extends BaseSettings<string> {
    type: SettingsTypes.color;
}

interface TextAreaSettings extends BaseSettings<string> {
    type: SettingsTypes.textarea;
}

interface AlertSettings extends BaseSettings<string> {
    type: SettingsTypes.alert;
}

interface WarningSettings extends BaseSettings<string> {
    type: SettingsTypes.warning;
}

interface InfoSettings extends BaseSettings<string> {
    type: SettingsTypes.info;
}

export type PluginSettings =
    | RangeSettings
    | ComboBoxSettings
    | CheckboxSettings
    | ButtonSettings
    | TextSettings
    | ColorSettings
    | TextAreaSettings
    | AlertSettings
    | WarningSettings
    | InfoSettings;
