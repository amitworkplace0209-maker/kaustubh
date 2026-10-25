# GITIGNORE_AUDIT.md

## `.gitignore` coverage audit

**Created**: 2026-09-28
**Method**: read-only. Compared the 101-line `.gitignore` against the actual 971 untracked
files, using `git check-ignore` for empirical verification.
**Status**: `STATIC_VERIFIED`. **Nothing was staged, committed, or ignored.**

---

## 1. Headline

> The `.gitignore` is **already good**. Secrets are excluded, and the existing patterns cover
> the bulk of the clutter. The real problem is **one 48.5 MiB data directory that nothing
> ignores**, which would bloat the first commit by ~76% of the untracked payload.

| Measure | Value |
|---------|-------|
| Untracked files | 971 |
| **Total untracked payload** | **63.44 MiB** |
| of which generated/downloaded data | **~51.8 MiB (82%)** |
| of which actual source + docs | ~11.6 MiB |

---

## 2. Verified as correctly ignored — no action needed

Empirically confirmed with `git check-ignore`:

| Path | Ignored | Why it matters |
|------|---------|----------------|
| `python-service/.env` | ✅ | **Contains `JWT_*`, broker keys, and PIN config. Confirmed NOT in git history.** This is the single most important line in the file |
| `.env`, `.env*.local` | ✅ | prevents secret commits |
| `.auth/` | ✅ | hashed-PIN storage |
| `/.next/` | ✅ | build output |
| `__pycache__/`, `*.py[cod]` | ✅ | incl. `khumbha-ai\__pycache__` |
| `*.log`, `logs/` | ✅ | incl. `khumbha-ai\bg_stdout.log`, and the 51 files in `python-service\logs\` (1.05 MiB) — none appear as untracked |
| `.venv/`, `venv/` | ✅ | |
| `python-service/runtime/` | ✅ | single-instance pid/state bookkeeping |
| `*.tsbuildinfo`, `next-env.d.ts` | ✅ | |

**No secret material is staged for commit.** The `.env` finding in
`security/AUTHENTICATION_AND_CONTROL_PLANE_EXPOSURE.md` is a *live-server* exposure risk,
not a *version-control* one.

---

## 3. The real gap — 48.5 MiB of downloaded market data

`python-service\downloads\` is **not ignored** and holds 4 files / **50,863,881 bytes
(48.51 MiB)**:

| File | Bytes | MiB | Nature |
|------|-------|-----|--------|
| `downloads/2026-08-17/ONGC/ONGC_2026-08-17.jsonl` | 23,010,417 | 21.94 | downloaded tick data |
| `downloads/2026-08-17/ONGC/ONGC_2026-08-17.ndjson` | 23,010,417 | 21.94 | **byte-identical duplicate** of the above |
| `downloads/2026-08-24/ONGC/ONGC_2026-08-24.zip` | 3,463,759 | 3.30 | downloaded archive |
| `downloads/2026-08-17/ONGC/ONGC_2026-08-17.jsonl.gz` | 1,379,288 | 1.32 | gzipped copy of the same data |

Three observations:
1. **The `.jsonl` and `.ndjson` are the same 23,010,417 bytes** — a redundant pair.
2. The `.gz` is a compressed copy of the same data. The same payload exists **three times**
   in 47.2 MiB.
3. This is **downloaded** market data, regenerable from the broker. It does not belong in
   version control.

`python-service\data\instrument_master.json` (**3,453,836 B / 3.29 MiB**) is a second
candidate. It is a generated instrument cache — but because it may be required at boot,
it is flagged as a **decision**, not an automatic ignore.

---

## 4. Recommended additions (not applied)

```gitignore
# ==========================
# Downloaded market data
# ==========================
python-service/downloads/
*.ndjson

# Generated instrument cache (3.3 MiB, regenerable)
# python-service/data/instrument_master.json

# ==========================
# Python tooling caches
# ==========================
.pytest_cache/
.mypy_cache/
.ruff_cache/
*.egg-info/
htmlcov/
.coverage
.coverage.*

# ==========================
# Local state / data
# ==========================
*.db
*.sqlite
*.sqlite3
```

### Decision needed on two items

| Item | Options |
|------|---------|
| `python-service/data/instrument_master.json` (3.29 MiB) | **(a)** ignore, regenerate on first run · **(b)** commit a trimmed sample + ignore the full file · **(c)** commit it despite the size |
| `opencode.json` (untracked, 1 file, root) | **(a)** commit — it is agent configuration worth sharing · **(b)** ignore — it is personal tooling config |

### Files that should stay **un**ignored

`docs\reports\kotak_wipro_live\*.jsonl` (9 files, 1.5–3.5 KB each) and the
`docs\reports\live\*.json` captures are **small audit evidence** and *should be committed*.
A blanket `*.jsonl` rule would discard them — the proposals above deliberately scope the
pattern to `*.ndjson` and to the `downloads/` path instead.

---

## 5. Defects in the existing file

| Issue | Lines | Fix |
|-------|-------|-----|
| **Duplicated Python block** — `.venv/`, `venv/`, `__pycache__/`, `*.py[cod]`, `*.pyo`, `*.pyd` appear twice | 41–49 and 80–88 | delete one copy |
| **Duplicated backup block** — `*.backup`, `*.before-*` appear twice | 75–79 and 90–94 | delete one copy |
| `next-env.d.ts` is ignored | 39 | Next.js's own guidance is to **commit** it. Harmless here (Next 16 regenerates it), but it can cause a clean-clone type-check difference. Low priority |

None of these break behaviour; they are tidiness issues.

---

## 6. What still needs a decision (outside `.gitignore`)

`.gitignore` is not the limiting factor for R-34. Even with the additions above, **~970
files / ~11.6 MiB of genuine source and documentation remain uncommitted**, including
~98,000 lines of frontend. Ignoring data files reduces the blob; it does not create
history. The recommended slicing is in `VERSION_CONTROL_STATE.md` §6.

---

## Related
- `audits/VERSION_CONTROL_STATE.md` — R-34, R-35
- `security/AUTHENTICATION_AND_CONTROL_PLANE_EXPOSURE.md` — live exposure (distinct from VCS)
- `PROJECT_RISKS.md`

---
*No `.gitignore` line was added, removed, or modified. No `git add` was executed.*
