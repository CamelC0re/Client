abstract class SettingsSchema {
    // Store sections in a dedicated property
    static settings: { [key: string]: Section };

    static serialize(): string {
        return JSON.stringify(this.settings ?? {});
    }

    static loadFromJSON(json: string): void {
        const data = JSON.parse(json);
        // Merge values into existing schema; support both full schema shape and flattened { section: { label: value } }
        for (const sectionKey of Object.keys(data)) {
            const incomingSection = data[sectionKey];
            const existingSection = this.settings?.[sectionKey];
            if (!existingSection || !Array.isArray(existingSection.fields)) continue;

            // Case 1: full schema-like shape with fields array
            if (incomingSection && Array.isArray(incomingSection.fields)) {
                incomingSection.fields.forEach((incomingField: any, index: number) => {
                    const existingField = existingSection.fields[index];
                    if (!existingField) return;
                    // Preserve existing validation if present
                    if (existingField.validation) {
                        incomingField.validation = existingField.validation;
                    }
                    // Apply value if provided
                    if (Object.prototype.hasOwnProperty.call(incomingField, 'value')) {
                        existingField.value = incomingField.value;
                    }
                });
                continue;
            }

            // Case 2: flattened shape { label: value }
            if (incomingSection && typeof incomingSection === 'object') {
                existingSection.fields.forEach((existingField: any) => {
                    if (!existingField) return;
                    const label = existingField.label;
                    if (Object.prototype.hasOwnProperty.call(incomingSection, label)) {
                        existingField.value = incomingSection[label];
                    }
                });
            }
        }
    }

    static getSettingValueByName(name: string): string | number | boolean | undefined {
        for (const sectionKey in this.settings) {
            const section = this.settings[sectionKey];
            const field = section.fields.find(f => f.label === name);
            if (field) return field.value;
        }
        return undefined;
    }
}

interface Section {
    heading: string;
    fields: Array<Field | DropdownField | DirectoryField>;
}

interface Field {
    label: string;
    type: SettingTypes;
    description?: string;
    default?: string | number | boolean;
    value?: string | number | boolean;
    validation: (value: string | number | boolean) => boolean | Promise<boolean>;
}
interface DropdownField extends Field {
    type: SettingTypes.DROPDOWN;
    options: { [key: string]: string | number | boolean };
}

interface DirectoryField extends Field {
    type: SettingTypes.DIRECTORY;
}

enum SettingTypes {
    STRING = 'string',
    NUMBER = 'number',
    BOOLEAN = 'boolean',
    DROPDOWN = 'dropdown',
    DIRECTORY = 'directory'
}



export class settingsSchema extends SettingsSchema {
    static settings = {
        Application: {
            heading: "Application Settings",
            fields: [
                {
                    label: "Release Channel",
                    type: SettingTypes.DROPDOWN,
                    description: "Select the release channel for updates.",
                    default: "Stable",
                    options: {
                        "Stable": "Stable",
                        "Beta": "Beta"
                    },
                    validation: (value) => ["Stable", "Beta"].includes(value as string),
                } as DropdownField
            ]
        },
        Plugins: {
            heading: "Plugin Settings",
            fields: [
                {
                    label: "Enable Plugins",
                    type: SettingTypes.BOOLEAN,
                    description: "Allow the use of plugins in Ryelite.",
                    default: true
                } as Field,
                {
                    label: "Allow Beta Plugins",
                    type: SettingTypes.BOOLEAN,
                    description: "Allow the use of beta plugins in Ryelite.",
                    default: false
                } as Field
            ]
        },
        Screenshots: {
            heading: "Screenshots",
            fields: [
                {
                    label: "Screenshot Directory",
                    type: SettingTypes.DIRECTORY,
                    description: "The directory where screenshots are saved.",
                    default: "/path/to/screenshots",
                    validation: async (value) => {
                        if (typeof value !== 'string' || !value.trim()) return false;
                        try {
                            const ok = await globalThis.electron.ipcRenderer.invoke('settings:validate-directory', value);
                            return Boolean(ok);
                        } catch {
                            return false;
                        }
                    }
                } as DirectoryField
            ]
        }
    };
}