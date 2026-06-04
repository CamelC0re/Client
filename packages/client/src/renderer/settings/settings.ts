// Use centralized settings API exposed by preload
import '@iconify/iconify';

const isDarwin = window.electron.process.platform === 'darwin';
// Hide the window controls if the OS is Darwin (macOS)
if (isDarwin) {
    const windowControls = document.getElementById('window-controls');
    if (windowControls) {
        windowControls.remove();
    }
} else {
    const darwinSpacer = document.getElementById('darwin-spacer');
    if (darwinSpacer) {
        darwinSpacer.remove();
    }
}

// Obtain references to the minimize, maximize, and close buttons
const minimizeButton = document.querySelector<HTMLAnchorElement>('#minimizeBtn');
const maximizeButton = document.querySelector<HTMLAnchorElement>('#maximizeBtn');
const closeButton = document.querySelector<HTMLAnchorElement>('#closeBtn');

// Add click event listeners to the buttons
if (minimizeButton) {
    minimizeButton.addEventListener('click', () => {
        window.electron.ipcRenderer.send('minimize-window');
    });
}
if (maximizeButton) {
    maximizeButton.addEventListener('click', () => {
        window.electron.ipcRenderer.send('toggle-maximize-window');
    });
}
if (closeButton) {
    closeButton.addEventListener('click', () => {
        window.electron.ipcRenderer.send('close-window');
    });
}

// Render settings UI from schema into #settings-content
function createFieldEl(sectionKey: string, field: any): HTMLElement {
    const fieldWrapper = document.createElement('div');
    fieldWrapper.className = 'setting-field';

    const label = document.createElement('label');
    label.className = 'setting-label';
    label.textContent = field.label;

    const desc = document.createElement('div');
    desc.className = 'setting-description';
    if (field.description) desc.textContent = field.description;

    let control: HTMLElement;
    const type: string = field.type;

    const nameAttr = `${sectionKey}:${field.label}`;
    const settingVal = field.value ?? field.default;

    switch (type) {
        case 'boolean': {
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = Boolean(settingVal);
            input.id = nameAttr;
            input.className = 'setting-input setting-checkbox';
            control = input;
            break;
        }
        case 'number': {
            const input = document.createElement('input');
            input.type = 'number';
            if (typeof settingVal === 'number') input.value = String(settingVal);
            input.id = nameAttr;
            input.className = 'setting-input setting-number';
            control = input;
            break;
        }
        case 'dropdown': {
            const select = document.createElement('select');
            select.id = nameAttr;
            select.className = 'setting-input setting-select';
            const options = field.options || {};
            Object.keys(options).forEach((key) => {
                const opt = document.createElement('option');
                opt.value = String(options[key]);
                opt.textContent = String(key);
                select.appendChild(opt);
            });
            if (settingVal !== undefined) select.value = String(settingVal);
            control = select;
            break;
        }
        case 'directory': {
            // Render as text input + choose button below
            const input = document.createElement('input');
            input.type = 'text';
            if (typeof settingVal === 'string') input.value = settingVal;
            input.id = nameAttr;
            input.placeholder = '/path/to/folder';
            input.className = 'setting-input setting-text';
            control = input;
            break;
        }
        case 'string':
        default: {
            const input = document.createElement('input');
            input.type = 'text';
            if (typeof settingVal === 'string') input.value = settingVal;
            input.id = nameAttr;
            input.className = 'setting-input setting-text';
            control = input;
            break;
        }
    }

    const right = document.createElement('div');
    right.className = 'setting-right';
    right.appendChild(control);

    // Add chooser button for DIRECTORY fields
    if (field.type === 'directory') {
        const chooseBtn = document.createElement('button');
        chooseBtn.type = 'button';
        chooseBtn.textContent = 'Choose…';
        chooseBtn.className = 'btn btn-secondary';
        chooseBtn.addEventListener('click', async () => {
            try {
                const currentVal = (control as HTMLInputElement).value || (typeof settingVal === 'string' ? settingVal : undefined);
                    const selected = await window.settings.selectDirectory({
                    title: `Select ${field.label}`,
                    defaultPath: currentVal,
                });
                if (selected) {
                    (control as HTMLInputElement).value = selected;
                    (control as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }));
                    (control as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));
                }
            } catch (e) {
                console.error('Directory selection failed', e);
            }
        });
        right.appendChild(chooseBtn);
    }
    if (field.validation) {
        const badge = document.createElement('span');
        badge.className = 'setting-badge';
        right.appendChild(badge);

        const updateBadge = async () => {
            let value: string | number | boolean;
            if ((control as HTMLInputElement).type === 'checkbox') {
                value = (control as HTMLInputElement).checked;
            } else if (control.tagName.toLowerCase() === 'select') {
                value = (control as HTMLSelectElement).value;
            } else {
                const v = (control as HTMLInputElement).value;
                value = (control as HTMLInputElement).type === 'number' ? Number(v) : v;
            }
            badge.textContent = 'Checking…';
            badge.classList.remove('ok', 'bad');
            const result = field.validation(value);
            const valid = result instanceof Promise ? await result : result;
            badge.textContent = valid ? 'Valid' : 'Invalid';
            badge.classList.toggle('ok', !!valid);
            badge.classList.toggle('bad', !valid);
        };

        control.addEventListener('input', updateBadge);
        control.addEventListener('change', updateBadge);
        updateBadge();
    }

    const left = document.createElement('div');
    left.className = 'setting-left';
    left.appendChild(label);
    if (field.description) left.appendChild(desc);

    fieldWrapper.appendChild(left);
    fieldWrapper.appendChild(right);
    return fieldWrapper;
}

async function renderSettings() {
    const container = document.getElementById('settings-content');
    if (!container) return;
    container.innerHTML = '';

    // Floating action bar (apply/reset)
    const actionBar = document.createElement('div');
    actionBar.id = 'settings-action-bar';
    const applyBtn = document.createElement('button');
    applyBtn.className = 'btn btn-apply';
    applyBtn.textContent = 'Apply';
    const resetBtn = document.createElement('button');
    resetBtn.className = 'btn btn-reset';
    resetBtn.textContent = 'Reset';
    actionBar.appendChild(resetBtn);
    actionBar.appendChild(applyBtn);
    document.body.appendChild(actionBar);

    const getVal = (el: HTMLElement): string | number | boolean => {
        if ((el as HTMLInputElement).type === 'checkbox') return (el as HTMLInputElement).checked;
        if (el.tagName.toLowerCase() === 'select') return (el as HTMLSelectElement).value;
        const inp = el as HTMLInputElement;
        return inp.type === 'number' ? Number(inp.value) : inp.value;
    };
    const setVal = (el: HTMLElement, v: any) => {
        if ((el as HTMLInputElement).type === 'checkbox') {
            (el as HTMLInputElement).checked = Boolean(v);
        } else if (el.tagName.toLowerCase() === 'select') {
            (el as HTMLSelectElement).value = String(v ?? '');
        } else {
            const inp = el as HTMLInputElement;
            inp.value = v == null ? '' : String(v);
        }
        (el as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }));
        (el as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));
    };

    const snapshot = new Map<string, string | number | boolean>();
    const controls: HTMLElement[] = [];
    const allSettings = await window.settings.getAll();
    const { settingsSchema } = await import('../../preload/settings');
    Object.entries(settingsSchema.settings).forEach(([sectionKey, section]: any) => {
        // Patch values from loaded settings
        (section.fields || []).forEach((field: any) => {
            if (allSettings?.[sectionKey]?.[field.label] !== undefined) {
                field.value = allSettings[sectionKey][field.label];
            } else {
                field.value = field.default;
            }
        });
        const sectionEl = document.createElement('section');
        sectionEl.className = 'settings-section';

        const header = document.createElement('h2');
        header.className = 'settings-heading';
        header.textContent = section.heading || sectionKey;

        const card = document.createElement('div');
        card.className = 'settings-card';

        (section.fields || []).forEach((field: any) => {
            const fieldEl = createFieldEl(sectionKey, field);
            // collect controls and seed snapshot
            const control = fieldEl.querySelector('.setting-input') as HTMLElement | null;
            if (control) {
                const key = `${sectionKey}:${field.label}`;
                (control as HTMLElement).setAttribute('data-key', key);
                controls.push(control);
            }
            card.appendChild(fieldEl);
        });

        sectionEl.appendChild(header);
        sectionEl.appendChild(card);
        container.appendChild(sectionEl);
    });

    // Initialize snapshot after DOM added
    controls.forEach((c) => {
        const key = (c as HTMLElement).getAttribute('data-key')!;
        snapshot.set(key, getVal(c));
    });

    const evaluateDirty = () => {
        const isDirty = controls.some((c) => {
            const key = (c as HTMLElement).getAttribute('data-key')!;
            const cur = getVal(c);
            const base = snapshot.get(key);
            // normalize numbers that are NaN vs empty
            if (typeof base === 'number' && typeof cur === 'number' && isNaN(base) && isNaN(cur)) return false;
            return cur !== base;
        });
        actionBar.classList.toggle('visible', isDirty);
    };

    // Wire change listeners for dirty tracking
    controls.forEach((c) => {
        c.addEventListener('input', evaluateDirty);
        c.addEventListener('change', evaluateDirty);
    });

    // Reset: revert to snapshot
    resetBtn.addEventListener('click', () => {
        controls.forEach((c) => {
            const key = (c as HTMLElement).getAttribute('data-key')!;
            const base = snapshot.get(key);
            setVal(c, base);
        });
        actionBar.classList.remove('visible');
    });

    // Apply: promote current values to snapshot
    applyBtn.addEventListener('click', async () => {
        const invalidElements = document.querySelectorAll('.bad')
        if (invalidElements.length > 0) {
            // Show validation error
            return;
        }

        // Write values back via settings API
        const merged: Record<string, any> = {};
        controls.forEach((c) => {
            const key = (c as HTMLElement).getAttribute('data-key')!; // Section:Label
            const [sectionKey, label] = key.split(':');
            merged[sectionKey] ||= {};
            merged[sectionKey][label] = getVal(c);
        });

        // Save new values via settings API
        await Promise.all(Object.entries(merged).flatMap(([sectionKey, fields]) =>
            Object.entries(fields).map(([label, value]) =>
                window.settings.set(sectionKey, label, value)
            )
        ));

        // Update snapshot after applying
        controls.forEach((c) => {
            const key = (c as HTMLElement).getAttribute('data-key')!;
            snapshot.set(key, getVal(c));
        });
        actionBar.classList.remove('visible');

        // Show restart-required modal
        const modal = document.getElementById('restart-modal');
        if (modal) {
            modal.classList.add('show');
            modal.setAttribute('aria-hidden', 'false');
            const okBtn = document.getElementById('restart-ok');
            if (okBtn) {
                const onClose = () => {
                    modal.classList.remove('show');
                    modal.setAttribute('aria-hidden', 'true');
                    okBtn.removeEventListener('click', onClose);
                };
                okBtn.addEventListener('click', onClose);
            }
        }
    });
}

document.addEventListener('DOMContentLoaded', renderSettings);