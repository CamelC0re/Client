# @ryelite/core 

This project/package provides two things in one. A plugin-type api to use during development as well as the core runtime used by RyeLite compatible clients.

## Installation

```bash
npm install @ryelite/core
-or-
yarn add @ryelite/core
```

## Usage

This package provides TypeScript type definitions for developing Ryelite plugins. Import the types you need:

```typescript
import { Plugin, IHighlite, PluginSettings } from '@ryelite/core';

export class MyPlugin extends Plugin {
    pluginName = 'MyAwesomePlugin';
    author = 'Your Name';

    init(): void {
        // Plugin initialization
    }

    start(): void {
        // Plugin startup logic
    }

    stop(): void {
        // Plugin cleanup
    }
}
```

## Available Types

### Core Interfaces

- `Plugin` - Base plugin class to extend
- `PluginSettings` - Plugin configuration interface

### Managers

- `NotificationManager` - In-game notifications
- `ItemTooltip` - Generic Tooltip Manager
- `UIManager` - Ryelite Centric way of creating on-screen UI Elements
- `PanelManager` - UI panel management
- `SettingsManager` - Plugin settings management
- `DatabaseManager` - Data persistence
- `SoundManager` - Audio management
- `ContextMenuManager` - Context menu handling
- `PluginManager` - Plugin Standup and State Management

### Reflector

This system handles class inference and auto-reflection based off signatures found in `signatures.ts` to automatically make classes and their functions available to consume in plugins.

### Utilities

* `AbbreviateValue` - Shortens large numbers to 1.1K, 1.11M, 1.111B, 1.1111T
* `Resources` - An extremely light IDB wrapper (Likely to depreceated)
* `LookupUtils` - Various helper functions for 

## Game Hooks

If you are building a plugin please read our guide on [how to make Game Hooks](https://github.com/Highl1te/Core/blob/main/docs/gamehooks.md).
