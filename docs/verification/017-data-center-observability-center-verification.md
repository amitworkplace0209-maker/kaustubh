# 017 Verification — Data Center Observability Center

- **Subject:** `docs/implementation/017-data-center-observability-center.md`
- **Date:** 2026-09-28
- **Verdict:** `VERIFIED_WITH_LIMITATIONS`
- **Meaning:** every automated suite that could be run passed, and six real
  defects were found and fixed. The live-deployment and browser claims remain
  `NOT VERIFIED` and are listed explicitly below.

---

## 1. What was actually executed

| # | Command | Working dir | Result |
| --- | --- | --- | --- |
| 1 | `python -m pytest tests -q -p no:randomly` | `python-service` | **1248 passed**, 12 subtests passed, 1 pre-existing DeprecationWarning |
| 2 | `python -m pytest tests/test_data_center.py -q` | `python-service` | 25 passed |
| 3 | `python -m pytest tests/test_data_center_planes.py -q` | `python-service` | 16 passed |
| 4 | `python -m pytest tests/test_data_center_planes_routes.py -q` | `python-service` | 5 passed, 12 subtests passed |
| 5 | `npx node --test tests/data-center-planes.test.ts` | repo root | **13 passed** |
| 6 | `npm test` | repo root | 287 tests: **286 passed, 1 failed** (see §4) |
| 7 | `npm run typecheck` | repo root | clean |
| 8 | `npm run build` | repo root | compiled, TypeScript clean, single `/data-saver/data-center` route |
| 9 | `npx eslint <changed files>` | repo root | clean |

Files covered by step 9: `lib/data-center.ts`, `lib/data-center-store.ts`,
`components/data-center/dc-planes.tsx`,
`app/(phase2)/data-saver/data-center/page.tsx`,
`app/api/phase2/data-center/route.ts`, `tests/data-center-planes.test.ts`.

---

## 2. Defects these runs caught (evidence, not assertion)

Each of these was observed as a **failing test or a failing build** and then
fixed. They are listed because a verification record that only reports green is
not evidence of anything.

| # | How it surfaced | Defect | Fix verified by |
| --- | --- | --- | --- |
| F1/F4 | `every wire section name is actually served by the proxy route` + `envelope carries every plane independently` failed | store requested `'dbwriter'`, proxy serves `'dbWriter'`; absent sections reported as errors | `tests/data-center-planes.test.ts` now passes; single typed `DC_WIRE_SECTIONS` |
| F5 | `next build` failed: `TS2339 Property 'authoritativeLabel' does not exist on type 'DcDbWriterPlane'` | test invented a field that never existed; `authoritative` was also missing from the real type | added `authoritative`, corrected the assertion, build clean |
| B1 | `test_server_status_unavailable_is_not_an_error_state` failed (`True is not false`) | a failed `serverStatus` was reported as **available with no metrics** | `_server_status_whitelist` now raises on failure and treats an empty/allow-list-less document as unavailable |
| B2 | `test_lists_real_ttl_indexes` failed (`('expiry', 1) != 'expiry'`) | pymongo returns `key` as a **list of pairs**; the code assumed a dict | added `_index_field()` handling both shapes |
| B3 | `test_reports_unavailable_when_not_connected` failed (`None != []`) | inconsistent "not measured" vs "measured zero" for `collections` | `null` + `storageError` on the failed path |
| B4 | `test_retention_plane_cache_key_includes_limit` failed (1 key, expected 2) | plane cache key ignored `limit` | `_plane(..., **key_parts)` |
| B5 | the same test then failed with `TypeError: _cache_key() got multiple values for argument 'name'` | `_cache_key`'s own first parameter was `name` | renamed to `_prefix` |
| route 503 | initial version of `test_plane_failure_returns_503_with_a_reason` failed | the test stubbed `_get_or_build`, so the real error path never ran; rewrote to stub the **builder** | 5 passed / 12 subtests |

**F1 deserves emphasis.** It was not a crash and not a warning. The proxy
filters unrecognised section names out of the request, so the 15-second live
poll simply stopped asking for DB Writer, and the panel kept rendering its
first-load value indefinitely. No test would have caught it, and no error would
have appeared on screen — on a page whose entire purpose is to not lie about
system state.

---

## 3. Claim-by-claim status

| Claim | Status | Evidence |
| --- | --- | --- |
| All six plane endpoints are routed and return 200 | **VERIFIED** | `test_data_center_planes_routes.py` via the real FastAPI router (12 subtests) |
| An unregistered plane path returns 404, not a fake success | **VERIFIED** | same file |
| A raising plane returns 503 with a reason | **VERIFIED** | same file, through the real `_get_or_build` |
| Retention `limit` is clamped and reaches the builder | **VERIFIED** | `test_retention_plane_clams_and_passes_limit_to_builder` |
| Planes do not share a cache entry across different args | **VERIFIED** | `test_retention_plane_cache_key_includes_limit` |
| No plane response contains a URI/credential/secret | **VERIFIED** | `test_no_plane_payload_contains_a_uri_or_secret` + `test_never_emits_a_uri_or_credential` |
| `serverStatus` is allow-listed, `host` not copied | **VERIFIED** | `test_never_emits_a_uri_or_credential` asserts `host` absent from the whitelisted output |
| Unconnected MongoDB yields `available: false`, not zeros | **VERIFIED** | `test_reports_unavailable_when_not_connected` |
| Engines come from the Registry, not a hard-coded list | **VERIFIED** | `test_documented_engines_carry_their_owner`, `test_undocumented_registry_engines_are_reported_not_dropped` |
| Topology edges are derived from the Registry | **VERIFIED** | `test_topology_edges_are_derived_from_the_registry` |
| A Registry failure is surfaced, not swallowed | **VERIFIED** | `test_registry_failure_is_reported_not_swallowed` |
| DB Writer counters are the writer's own | **VERIFIED** | `test_republishes_the_writers_own_snapshot` |
| Unmapped collections are `UNMAPPED` / `NOT VERIFIED` | **VERIFIED** | `test_unmapped_collection_is_flagged_not_guessed` |
| A failing index scan does not abort the retention plane | **VERIFIED** | `test_one_failing_index_scan_does_not_abort_the_plane` |
| The ownership map is fully attributed; `ticks` → DB Writer | **VERIFIED** | `OwnershipMapTest` |
| Frontend normalizers never coerce missing → 0/[]/false | **VERIFIED** | 11 normalizer tests in `tests/data-center-planes.test.ts` |
| One failed section does not blank or error the others | **VERIFIED** | `envelope carries every plane independently` |
| Wire section names match the proxy exactly, both directions | **VERIFIED** | `every wire section name is actually served by the proxy route` |
| One canonical Data Center page; no duplicate route | **VERIFIED** | `next build` route table |
| TypeScript is clean and the app builds | **VERIFIED** | steps 7–8 |
| Data Center is read-only; no write call in a plane | **VERIFIED (static)** | call-site review, backend audit §5 |
| **Real `serverStatus` / `index_information()` shapes** | **NOT VERIFIED** | fakes only; no live MongoDB |
| **Live MongoDB: storage totals, owners, TTL indexes** | **NOT VERIFIED** | no live DB run |
| **Atlas privilege tier behaviour for `serverStatus`** | **NOT VERIFIED** | reasoned from docs, not observed |
| **Engine registry at runtime (17 engines, states, health)** | **NOT VERIFIED** | no live bootstrap |
| **Broker / session-manager / scheduler state** | **NOT VERIFIED** | not in scope of this change |
| **Layout at 375/390/430/768/1024/1280/1440/1920** | **NOT VERIFIED** | no browser, no screenshot |
| **PWA standalone + safe-area rendering on a real device** | **NOT VERIFIED** | no device |
| **A real envelope from a live backend rendering in the UI** | **NOT VERIFIED** | no dev server |
| **Ownership map correctness against runtime reality** | **NOT VERIFIED** | static, code-derived, unratified |

---

## 4. The one failing test — not a regression

```
test at tests\topbar-status.test.ts:331
  canonical session state never invents ACTIVE
  AssertionError: actual 'INACTIVE', expected 'AUTHENTICATING'
```

Determined unrelated by inspection of imports: that file imports **only**
`lib/topbar-status.ts`, which none of this work creates, edits, or imports. The
Data Center work touches no session, auth, or topbar code. The failure is
present on the untouched tree and was neither introduced nor fixed here.

**Recorded, not suppressed, and not worked around.**

---

## 5. Environment caveat found while verifying

`mock.patch.object(module, "PLANS", new_dict)` raised
`AttributeError: ... does not have the attribute 'PLANS'` under pytest while the
same call succeeded in a plain interpreter, even though `PLANES` was present in
`module.__dict__`. The same effect was obtained reliably with
`mock.patch.dict(module.__dict__, {...})`, which is what the route test uses.
This is recorded because it cost real time and would otherwise look like a
product bug; it is **not** a defect in `data_center_planes.py`.

---

## 6. Recommended next verification (in priority order)

1. Start the backend against a real (or Atlas free-tier) MongoDB and curl all
   six endpoints. Compare the `serverStatus` and `index_information()` shapes
   against the fakes used here — this is the single highest-value remaining
   check, because B1 and B2 were both shape bugs.
2. Sign off the `COLLECTION_OWNERS` / `DOCUMENTED_ENGINES` maps against a write-
   path audit, row by row, using each row's `basis` field.
3. Run the page in a browser at all eight required widths and capture the
   DB Writer panel during a live poll, to confirm the 15s path is exercised
   (F1's regression is only observable over time).
4. Fix the pre-existing `TICK_PERSISTENCE_LABELS` mojibake in
   `services/db_writer_engine.py` — it is now user-visible on the Data Center.
5. Fix or triage `tests/topbar-status.test.ts:331` separately.
