# Archive Manifest

Everything under `archive/legacy/` is **not part of the active build**.
`tsconfig.json` excludes `archive`. Nothing here is served or compiled.

Any file placed here was either superseded by the unified architecture or was a
duplicate/orphan. To restore something, move it back into the active tree,
rewire its imports, and re-run the verification workflow
(`docs/TESTING.md`).

## Routes

| Path | Why archived |
|------|--------------|
| `routes/(dashboard)/layout.tsx` | Legacy sidebar layout. Canonical pages now live in `app/_pages/` (non-routed). |
| `routes/(data)/` | Legacy Data application — superseded by the Data Saver app at `/data-saver/*`. |
| `routes/workspace/` | Obsolete workspace placeholder (redirected to `/login`). |
| `routes/phase2-legacy/` | Legacy `/phase2/*` redirect shim — superseded by explicit redirects in `next.config.js` pointing to `/data-saver/*`. |

## Backend

| Path | Why archived |
|------|--------------|
| `backend/` | Orphaned older Node.js backend skeleton. The single active backend is `python-service/`. |

## Components

| Path | Why archived |
|------|--------------|
| `components/sidebar.tsx` | Legacy monolithic sidebar/topbar (old flat routes). Replaced by `components/layout/global-sidebar.tsx` + `global-topbar.tsx`. |
| `components/workspace-provider.tsx` | Legacy workspace stack (trading/data/services/ai). Replaced by the unified `Shell` + `Phase2Provider`. |
| `components/workspace-sidebar.tsx` | Legacy workspace sidebar. |
| `components/workspace-topbar.tsx` | Legacy workspace topbar. |
| `components/theme-provider.tsx` | next-themes wrapper — superseded by `lib/phase2-theme.ts`. |
| `components/custom-theme-provider.tsx` | Legacy custom palette provider — superseded by the unified theme engine. |
| `components/theme-switcher.tsx` | Legacy dark/light/AMOLED switcher — superseded by the Shell topbar theme dropdown (system mode added). |

## Lib

| Path | Why archived |
|------|--------------|
| `lib/workspace-nav.ts` | Legacy per-workspace navigation — canonical configs now in `components/layout/nav.ts` + `lib/apps.ts`. |
| `lib/custom-theme.ts` | Legacy custom theme store — superseded by `lib/phase2-theme.ts`. |
| `lib/systems.ts` | Legacy workspace/system detection used only by the archived `components/sidebar.tsx`. |

## Docs

| Path | Why archived |
|------|--------------|
| `docs/PROJECT_STRUCTURE.md` | Superseded by `docs/PROJECT_STRUCTURE.md` (current tree). |
| `docs/ARCHITECTURE.md` | Superseded by `docs/ARCHITECTURE.md`. |
| `docs/INSTALLATION.md` | Superseded by `docs/INSTALLATION.md`. |
| `docs/DEPENDENCIES.txt` | Superseded by `docs/DEPENDENCIES.md`; canonical pins stay in `version-lock.txt`. |
| `docs/README_local.md` | Historical local documentation. |
| `docs/FINAL_VERIFICATION.md` | One-off verification report, superseded by `docs/TESTING.md`. |
| `docs/MIGRATION_PLAN.md` / `docs/MIGRATION_PROGRESS.md` | Old phase migration bookkeeping, completed. |
| `docs/PHASE2_VERIFICATION.md` | One-off Phase 2 verification report. |
| `docs/PRODUCTION_READINESS_REPORT.md` | One-off readiness report (history). |

## Notes

- Archived code may reference modules that no longer exist in the active tree —
  this is intentional; it is excluded from typecheck/build.
- The unified theme engine migrates the old single-key preference
  (`phase2_theme_state`) into the Data Saver app key once.
- `next.config.js` keeps backward-compatible redirects (`/data/*`, `/phase2/*`,
  `/stocks`, `/downloads*`) to the live `/data-saver/*` routes.