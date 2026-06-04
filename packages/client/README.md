<p><img src="https://github.com/user-attachments/assets/da5bb809-3949-4854-99e4-1619022444e7" width="128"/></p>
<p>
  <a href="https://discord.gg/highspell"><img alt="JoinDiscord" src="https://img.shields.io/badge/Discord-Join_Us-purple?style=flat&logo=Discord&label=Discord"/></a>
  <img alt="GitHub License" src="https://img.shields.io/github/license/Highl1te/HighliteDesktop">
  <img alt="Build Status" src="https://img.shields.io/github/actions/workflow/status/Highl1te/HighliteDesktop/main.yml">
  <img alt="Downloads" src="https://img.shields.io/github/downloads/Highl1te/HighliteDesktop/latest/total?label=Downloads&color=blue">
</p>

# RyeLite

RyeLite is an open-source game client for High Spell, forked from HighLite. RyeLite is aimed to be a continuation of HighLite, as HL is no longer updated.

# Installing RyeLite
RyeLite is packaged as an Electron application and provides [Linux](#Linux), [MacOS](#MacOS), and [Windows](#Windows) support.

## Windows
1. Obtain the .exe file from the [latest release](https://github.com/ash-of-the-meadow/RyeliteDesktop/releases/latest)
> [!WARNING]
> In Microsoft Edge, you may recieve a download warning due to RyeLite not being commonly downloaded.
>
> ![image](https://github.com/user-attachments/assets/8dd15f93-29c4-42a8-966b-1bd8a83fa66c)
>
> You can typically resolve this by clicking '...' and selecting 'Keep'


> [!WARNING]
> RyeLite is currently un-signed due to the inherent cost of obtaining signing certificates for software. This results in install and download warnings.
> If we recieve enough players (or complaints!) we will invest in obtaining certificates.
>
> ![image](https://github.com/user-attachments/assets/90651443-a7ed-42b1-8e60-60af2a54fbf1)
>
> You can resolve this by clicking 'More Info' and pressing 'Run anyway'
>
> ![image](https://github.com/user-attachments/assets/f1537d49-7aac-4344-ba6a-77a01339e63f)
>

3. Install RyeLite
4. You will be prompted by the game client when launching to automatically install any future updates!
## Linux
1. Obtain the .AppImage file from the [latest release](https://github.com/ash-of-the-meadow/RyeliteDesktop/releases/latest)
2. Execute the AppImage
3. You will be prompted by the game client when launching to automatically install any future updates!
## MacOS
> [!CAUTION]
> MacOS builds go largely untested so they may be more prone to buggy behavior.

1. Instructions Pending

# Related Repositories
The RyeLite ecosystem is distributed across multiple repositories, each serving a specific purpose in the overall architecture.

### [Desktop Application](https://github.com/ash-of-the-meadow/RyeliteDesktop)
This repository! The desktop application handles:
- Electron-based desktop application mechanics
- Window management and user interface
- Core and plugin loading system
- Auto-updater functionality
- Cross-platform builds (Windows, Linux, macOS)

### [Core](https://github.com/ash-of-the-meadow/rl-core)
The core repository provides two APIs for interacting with the High Spell game code:
- **@highlite/plugin-api** - Deprecated API - TypeScript type definitions for plugin development - Older api to support current plugins. Support is maintained, but new plugins and code should use ryelite-core.
- **@ryelite/core** - TypeScript type definitions for plugin development - Current up-to-date api that newer code and plugins should use, unless a feature is only available in the older api.
Both APIs support:
- Game state monitoring and interaction APIs
- High Spell game client integration layer
- Plugin development framework and utilities
- Shared interfaces for game data access

### [Plugin Hub](https://github.com/ash-of-the-meadow/rl-plugin-hub)
The Plugin Hub serves as the central registry:
- Verified plugin configurations
- Plugin version management

# Development
## Prerequisites
- **Node.js v22 LTS** - [Download here](https://nodejs.org/en/download)
- **Yarn v4** - Managed via Corepack (comes with Node.js)

## Getting Started
1. **Clone the repository**
   ```bash
   git clone https://github.com/ash-of-the-meadow/RyeliteDesktop.git
   cd RyeliteDesktop
   ```

2. **Install dependencies**
   ```bash
   yarn install
   ```
## Development Commands
### Development Mode
```bash
yarn dev          # Start development server with hot reload
yarn start        # Preview built application without packaging
```

### Building
```bash
yarn build        # Build the application for production (automatically runs prebuild)
yarn build:unpack # Build and create unpacked directory
```

### Platform-Specific Builds
```bash
yarn build:win    # Build Windows installer (.exe)
yarn build:mac    # Build macOS application (.dmg)
yarn build:linux  # Build Linux AppImage
```

### Code Quality
```bash
yarn format       # Format code with Prettier
yarn format:check # Check code formatting
yarn format:fix   # Fix formatting issues
```

## Project Structure
- **`src/main/`** - Electron Main Process (Node Client Rendering)
- **`src/preload/`** - Preload Scripts (Middle-man APIs between Node Client and Web Page)
- **`src/renderer/`** - Renderer process (Web Page Rendering)
- **`scripts/`** - Build and development scripts
- **`build/`** - Application icons and build assets
