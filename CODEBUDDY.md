# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

## Project Overview

**TimeWrite (智写时光)** is a cross-platform desktop novel writing application targeting web fiction authors. Built with **Tauri v2** (Rust backend + React frontend). Current version: `0.6.0`.

## Development Commands

```bash
# Install dependencies (requires pnpm >= 9, node >= 20)
pnpm install

# Start Tauri dev mode (frontend + Rust backend with hot reload)
pnpm tauri dev

# Frontend-only dev server (Vite on port 1420, no Rust backend)
pnpm dev

# Type-check + build frontend
pnpm build

# Full production build (Rust binary + installer)
pnpm tauri build

# Project integrity check
pnpm check

# Preview production frontend build
pnpm preview
```

No test runner or linter is configured in this project.

## Tech Stack

- **Frontend**: React 19 + TypeScript 6 + Vite 8 + TailwindCSS v4 (CSS-first, no `tailwind.config.ts`)
- **Backend**: Rust (Tauri v2) + SQLite (rusqlite, WAL mode, r2d2 pool, max 10 connections)
- **Rich text editor**: TipTap with extensions (code block, image, table, task list, underline, color, character count)
- **State**: Zustand (business/persistent state in localStorage) + Jotai (ephemeral UI state)
- **Routing**: React Router v7 with lazy loading for Editor and Settings pages
- **Package manager**: pnpm with `shamefully-hoist=true` (required for Tauri native modules)

## Architecture

### Tauri Hybrid Architecture

Frontend runs in a webview; Rust backend runs natively. Communication via Tauri IPC (`invoke` calls), all wrapped in a type-safe bridge layer at `src/lib/tauri-bridge.ts`. Every IPC command has a typed wrapper function.

### Directory Structure

```
src/                     # Frontend (React/TypeScript)
  main.tsx               # Entry point with ErrorBoundary
  App.tsx                # Root component, theme init, deep-link window detection
  types/index.ts         # Core TypeScript types (Book, Chapter, Volume, Snapshot, WorldCard, AiConfig)
  router/index.tsx       # Routes: / (Library), /editor/:bookId, /settings
  stores/
    appStore.ts          # Zustand global business state
    uiAtoms.ts           # Jotai atoms for ephemeral UI state
    pluginStore.ts       # Plugin state management
  lib/
    tauri-bridge.ts      # Type-safe Tauri IPC wrappers (all commands)
    utils.ts             # cn(), formatWordCount, countWordsFromHtml
  plugins/               # Extension-point plugin system
  components/            # Grouped by domain: library/, editor/, outline/, layout/, settings/, worldbuilding/, ai/, common/
  pages/                 # LibraryPage, EditorPage, SettingsPage
  styles/globals.css     # TailwindCSS v4 entry with theme variables

src-tauri/               # Rust backend
  src/
    main.rs              # Entry point, delegates to lib::run()
    lib.rs               # Tauri builder: plugin registration, DB init, 38+ IPC commands
    db/mod.rs            # SQLite module (6 tables, WAL mode, auto-migration)
    models/mod.rs        # Rust data models (serde rename to camelCase for frontend)
    commands/            # book.rs, volume.rs, chapter.rs, snapshot.rs, world_card.rs, ai.rs, io.rs, window.rs
```

### Key Patterns

- **Import alias**: `@/*` maps to `src/*` (configured in both `tsconfig.json` and `vite.config.ts`)
- **Dual state management**: Zustand for persistent business data, Jotai for ephemeral UI state (editor focus, panel visibility, saving status)
- **SQLite auto-migration**: Schema uses `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ADD COLUMN` inline in `db/mod.rs` — no separate migration files
- **Soft delete**: `deleted_at` column on books, volumes, chapters; trash/restore pattern
- **Auto-save**: Dual strategy (300ms debounce + 3-minute timer) for chapter content
- **Multi-window**: Deep-link protocol `com.ukcoder.timewrite://` opens separate always-on-top windows for world-building and version history
- **Rust serde convention**: All Rust structs use `#[serde(rename = "camelCase")]` to match frontend TypeScript types
- **localStorage persistence**: Theme, eyecare, font, AI config, editor state, AI conversations

### Database Tables

`books`, `volumes`, `chapters`, `snapshots`, `world_cards`, `embeddings` — all use TEXT primary keys (UUIDs).

### Theme System

4 theme modes (light, dark, eyecare-warm, eyecare-green) implemented via CSS custom properties in HSL color space. Defined in `src/styles/globals.css` with TailwindCSS v4 `@theme` and `@custom-variant` directives.

### Code Splitting

Manual chunks in `vite.config.ts` separate: tiptap, icons (lucide-react), state (zustand/jotai), router, markdown, utils (date-fns/uuid), virtual (@tanstack/react-virtual).

### Plugin System

Extension-point based (editor-toolbar, editor-sidebar, library-card, export-format, ai-prompt, command-palette). `PluginManager` is a singleton; plugins defined via `definePlugin()` helper.

## Language

UI text and code comments are in Chinese. This is a Chinese-first product.

## CI/CD

- **Release**: Triggered by `v*` tags. Builds macOS ARM64 (DMG) and Windows (NSIS EXE).
- **Landing page**: GitHub Pages deployment from `product/` directory.
- **Wiki**: Syncs `docs/` to GitHub Wiki with directory flattening.

## Tauri Configuration Notes

- App identifier: `com.ukcoder.timewrite`
- Default window: 1280x800, min 800x600
- Bundle targets: DMG (macOS), NSIS (Windows)
- `beforeDevCommand` runs `npm run dev`, `beforeBuildCommand` runs `npm run build`
- `.npmrc` requires `node-linker=hoisted` and `shamefully-hoist=true` for Tauri compatibility
