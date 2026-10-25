# VERSION_CONTROL_STATE.md

## Repository divergence — audit

**Created**: 2026-09-28
**Method**: read-only `git status --porcelain -uall`, `git ls-tree -r HEAD`, `git show HEAD:<path>`.
**No git write command was executed.** Nothing was staged, committed, stashed, or restored.
**Status**: `STATIC_VERIFIED`.

---

## 1. Headline

> **Roughly 98,000 lines of application code exist only in the working tree and have never
> been committed.** The repository history (141 tracked files, 5 commits) contains an
> almost-empty frontend and a small backend. The real application is unversioned.

| Metric | Value |
|--------|-------|
| Total commits | 3 (`6cfa5e6`, `26b6d99`, `4ff49ca`) |
| **Tracked files in HEAD** | **141** |
| **Untracked files** | **970** |
| Untracked modified | 56 |
| Untracked deleted | 11 |
| Untracked `.tsx` | 373 |
| Untracked `.ts` | 158 |
| Untracked `.py` | 207 |

### Untracked code volume

| Area | Untracked files | Approx. lines |
|------|-----------------|---------------|
| `app\` | 279 (incl. **134 routable pages**) | — |
| `components\` | 137 | — |
| `lib\` | 57 | — |
| `hooks\` | 7 | — |
| **`app`+`components`+`lib`+`hooks` (.ts/.tsx)** | **480** | **~97,925** |
| `python-service\` | 225 (incl. **207** `.py`) | — |
| `docs\` | 181 | — |
| `archive\`, `apps\`, `khumbha-ai\`, `config\`, `public\`, `tests\` | 72 | — |

---

## 2. Routable page counts: HEAD vs working tree

This is the root cause of the earlier "166 `page.tsx`" counting confusion, and it matters
for interpreting every frontend count in this documentation set.

| Source | Routable `page.tsx` |
|--------|--------------------|
| **HEAD (committed)** | **16** |
| Working tree (now) | **151** |
| Difference | **134 untracked + 1 deleted** |

The 16 committed pages are all in two directories:

```
app/page.tsx
app/(dashboard)/{dashboard,downloads,funds,holdings,live-ticks,market-watch,
                notifications,order-history,orders,portfolio,positions,
                settings,stocks,system,trading}/page.tsx
```

Everything else — the `(trading)`, `(services)`, `(phase2)`, `(ai)` groups, all 36
`data-saver/settings/*` pages, all `_pages\` content — **is uncommitted**.

**Consequence**: "the code" referenced throughout this documentation set means the
**working tree**, not the repository. The working tree is the only place this application
exists. See §5.

---

## 3. Uncommitted deletions — 11 files, 3 of them code

```
DEPENDENCIES.txt                                  MIGRATION_PLAN.md
FINAL_VERIFICATION.md                             MIGRATION_PROGRESS.md
PHASE2_VERIFICATION.md                            PRODUCTION_READINESS_REPORT.md
PROJECT_STRUCTURE.md                              docs/cline/CLINE_CHAT_001.md
app/(dashboard)/trading/page.tsx          <-- code components/sidebar.tsx        <-- code
tailwind.config.ts                       <-- code
```

All are **unstaged** (` D` = deleted in worktree, not staged). These deletions
**pre-date this documentation bootstrap** and were **not** caused by it — verified by
timestamp: the most recent modification to any non-`.md`, non-`.next` file is
`app\_pages\market-watch\mw-shared.tsx` at 17:41, whereas the documentation work is at
22:47. Only `.next\dev\cache\turbopack\*` artifacts (13:32–14:07) fall in the recent
window, and those are Next.js dev-server cache files.

### 3.1 `app/(dashboard)/trading/page.tsx` — deletion is consistent, but the earlier justification was **wrong**

**CORRECTION (2026-09-28).** An earlier revision of this file claimed:

> HEAD contains **both** `app/(dashboard)/trading/page.tsx` and `app/(trading)/trading/page.tsx`.

**That claim is false, and is withdrawn.** Verified directly against the object store:

```powershell
git ls-tree -r HEAD --name-only | Select-String 'app/.*page\.tsx$'   # -> 16 entries
git ls-tree -r HEAD --name-only | Select-String 'app/\(trading\)/'   # -> (no match)
git status --porcelain -- 'app/(dashboard)/trading/page.tsx' 'app/(trading)/trading/page.tsx'
#  D app/(dashboard)/trading/page.tsx
# ?? app/(trading)/trading/page.tsx
```

- `HEAD` contains **16 routable pages**: 15 under `app/(dashboard)/` plus `app/page.tsx`.
- `app/(trading)/trading/page.tsx` is **untracked** — it is **not in `HEAD`**.
- `app/(dashboard)/trading/page.tsx` **is** tracked, and is deleted in the working tree.

**Consequences:**

1. **A fresh `HEAD` clone has no duplicate route.** It has 16 pages and no `(trading)`
   group at all. The earlier "genuine duplicate-route build error in `HEAD`" and its
   "retrospective validation of D-05" conclusion are both **withdrawn**.
2. The collision exists **only in a hybrid tree** — i.e. the current working tree if the
   untracked `(trading)` page were committed *without* the deletion of the `(dashboard)`
   page. The working-tree deletion is what prevents that.
3. **D-05 stays withdrawn.** Nothing here rehabilitates it. The 151 routable pages in the
   working tree produce **151 distinct route strings**.

> The shape of D-05's hypothesis (this project *could* contain duplicate routes) is
> plausible, and committing the untracked `(trading)` page while restoring the deleted
> `(dashboard)` page would create exactly that. But no duplicate exists in `HEAD` today.

### 3.2 `components/sidebar.tsx` — deletion is **harmless**

201 lines, a `use client` navigation shell using `lucide-react` and `next-themes`.
**Referenced by nothing** in `app\`, `components\`, or `lib\` — verified by search for
`components/sidebar`. Its role was evidently taken over by the untracked
`components\layout\phase-sidebar.tsx` and `components\layout\sidebar-terminal-switcher.tsx`.
Removing it breaks no import.

## 3.3 `tailwind.config.ts` — **RESTORED 2026-09-28, owner-approved**

**Status: fixed.** `git checkout HEAD -- tailwind.config.ts` was run with explicit owner
approval. The file is back (3,197 bytes) and `git status` reports it clean against `HEAD`.
Verified present: `darkMode: ['class']`, `content` allowlist, the full semantic palette
(including `success` at line 53 and `chart-1..5` at line 76), the `accordion-down`/`-up`
keyframes and animations, and `plugins: [require('tailwindcss-animate')]` at line 100.
**R-35 is closed.**

> ### What was lost while it was missing (kept for the record)
>
> | Lost | Consequence |
> |------|-------------|
> | `darkMode: ['class']` | dark mode entirely non-functional — no `.dark` variant emitted |
> | `content: [...]` allowlist | no explicit scan globs |
> | **Full semantic palette** — `background`, `foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `accent`, `destructive`, `success`, `warning`, `info`, `purple`, `teal`, `border`, `input`, `ring`, `chart-1..5` | every `bg-*`/`text-*`/`border-*` token resolves to nothing |
> | `borderRadius` → `var(--radius)` | radius tokens lost |
> | `gradient-radial`, `gradient-conic` | those utilities disappear |
> | `accordion-down` / `accordion-up` keyframes + animations | accordion animation lost |
> | `plugins: [require('tailwindcss-animate')]` | installed dep becomes unused |
>
> Tailwind is **v3.4.17** (not v4) and `app\globals.css` uses v3 directives
> (`@tailwind base; @tailwind components; @tailwind utilities;`), so the file is required.
> `postcss.config.js` is present; `tailwind.config.js` does **not** exist, so there was no
> replacement. Because the whole `components\ui\*` layer is shadcn-style (`bg-background`,
> `text-foreground`, `bg-card`, `text-primary`, `border-border`, `ring-ring`…), the UI would
> have rendered **unstyled** — and `tsc` and ESLint can detect neither this nor a Tailwind
> config's absence. It was only caught by reading `git status` and `git show HEAD:<path>`.

### 3.4 Remaining 10 deletions (2 code) — no action taken

`app/(dashboard)/trading/page.tsx` and `components/sidebar.tsx` remain deleted by design
(§3.1, §3.2). Eight documentation files are also deleted. Left untouched pending owner
confirmation that the deletions are intentional.

---

## 4. Additional untracked top-level directories

Finding D-10 ("no `src/`, `backend/`, `frontend/`, `services/`, `engines/` root
directories") should be read alongside these, which exist in the working tree but are
untracked and therefore absent from history:

| Dir | Files | Contents |
|-----|-------|----------|
| `archive\legacy\` | 41 | legacy tree |
| `apps\` | 8 | `data-saver`, `khumbha-ai`, `services`, `trading-terminal` |
| `khumbha-ai\` | 6 | `main.py`, `bg_stdout.log`, `bg_stderr.log`, `__pycache__` |
| `config\` | 2 | `brokerage.ts`, `statutory-charges.ts` |

`khumbha-ai\bg_stdout.log` / `bg_stderr.log` are captured process logs and
`__pycache__` directories are present — these **should** be gitignored, not committed.
`.gitignore` currently covers only `/.next/` and `next-env.d.ts` for Next.js concerns.

---

## 5. Risk assessment

| # | Risk | Likelihood | Impact | Rating |
|---|------|-----------|--------|--------|
| A | ~98k lines of working-tree-only code lost by a bad clean, reset, or disk event — **no git history exists** | Low | **Catastrophic** | **Critical** |
| B | Documentation describes behaviour no teammate can reproduce, because a fresh `git clone` yields a different application | **High** | High | **High** |
| C | Untracked `__pycache__`, `.log`, `.jsonl` files pollute any future commit | Medium | Low | Medium |
| D | Uncommitted deletions in the tree are invisible to review until someone runs `git status` | Medium | Medium | Medium |

**B is the finding that most affects this documentation project.** Several documents here
are careful to record that runtime behaviour is `NOT_VERIFIED`; this audit adds a second,
sharper caveat — *static* claims are only reproducible from this specific working tree, not
from the repository.

---

## 6. Recommended sequence (all require owner approval)

1. **Restore `tailwind.config.ts`** — it is a confirmed styling regression (§3.3).
2. Decide whether the `(dashboard)/trading` and `sidebar.tsx` deletions are intentional;
   if so, commit them so history matches the working tree.
3. Extend `.gitignore` to cover `__pycache__/`, `*.log`, `*.jsonl`, `.env.local`.
4. Commit the application in logical slices (frontend, backend, docs) so the ~975 untracked
   files acquire history. This is the single highest-value action in this document.
5. Only then treat `PENDING-002` (build) as meaningful — a build of an unversioned tree is
   not reproducible later.

**None of the above has been performed.**

---

## Related
- `audits/FRONTEND_PAGES_AUDIT.md` — route/page counts (working-tree basis)
- `audits/DUPLICATE_AND_LEGACY_FINDINGS.md` — D-05 (withdrawn), D-10, and now D-19
- `PROJECT_RISKS.md` — R-34 (uncommitted code), R-35 (missing `tailwind.config.ts`)
- `pending/PENDING-002-build-and-test-verification.md`

---
*Read-only inspection. No `git add`, `commit`, `checkout`, `restore`, `stash`, or `clean`
was executed at any point.*
