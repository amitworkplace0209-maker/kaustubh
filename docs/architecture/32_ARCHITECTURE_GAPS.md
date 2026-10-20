**STATUS: MIGRATED 2026-09-23 � 4-WS model (WebSocket_ConnectionManager_Flow.md + 08_WEBSOCKET_ARCHITECTURE.md). Dual description WS#1+WS#2 collapsed; now WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend. See 08/09 for canonical flows.**

# 32_ARCHITECTURE_GAPS.md - Architecture Gaps Analysis

## 32.1 Architecture Gaps Overview
This document identifies all gaps between the current implementation and the approved target architecture.

## 32.2 Gap Inventory

### Gap 1: sqareoff_engine DEGRADED
| Field | Value |
|-------|-------|
| **Severity** | HIGH |
| **Engine** | sqareoff_engine |
| **Current State** | DEGRADED |
| **Target State** | RUNNING |
| **Root Cause** | Position tracking inconsistency |
| **Impact** | End-of-day squareoff may fail |
| **Detection** | State stamp shows DEGRADED |
| **Recovery** | Reconciliation + restart |
| **Priority** | 1 |
| **Estimated Fix Time** | 15 minutes |
| **Steps** | 1. Run `python -m kaushub.engine reconcile positions` |
| | 2. Run `python -m kaushub.engine sync positions` |
| | 3. Run `python -m kaushub.engine restart sqareoff_engine` |
| | 4. Verify state: `python -m kaushub.engine status sqareoff_engine` |

### Gap 2: audit_engine UNKNOWN
| Field | Value |
|-------|-------|
| **Severity** | HIGH |
| **Engine** | audit_engine |
| **Current State** | UNKNOWN |
| **Target State** | RUNNING |
| **Root Cause** | Engine not yet started at runtime |
| **Impact** | No audit trail, compliance gap |
| **Detection** | No runtime events received |
| **Recovery** | Start engine manually |
| **Priority** | 1 |
| **Estimated Fix Time** | 5 minutes |
| **Steps** | 1. Run `python -m kaushub.engine start audit_engine` |
| | 2. Verify state: `python -m kaushub.engine status audit_engine` |
| | 3. Check audit_log collection in MongoDB |

### Gap 3: watchlist_target_engine UNKNOWN
| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **Engine** | watchlist_target_engine |
| **Current State** | UNKNOWN |
| **Target State** | RUNNING |
| **Root Cause** | Composite engine not initialized |
| **Impact** | Combined watchlist+target feature incomplete |
| **Detection** | Engine not observed starting |
| **Recovery** | Initialize composite engine |
| **Priority** | 2 |
| **Estimated Fix Time** | 10 minutes |
| **Steps** | 1. Run `python -m kaushub.engine start watchlist_target_engine` |
| | 2. Verify dependencies (watchlist_engine, target_engine) are RUNNING |
| | 3. Verify state: `python -m kaushub.engine status watchlist_target_engine` |

### Gap 4: 3 Engines Not Reporting State Stamps
| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **Affected Engines** | audit_engine, watchlist_target_engine, + 1 more |
| **Current State** | UNKNOWN |
| **Target State** | RUNNING with state_stamp |
| **Root Cause** | Engines not started or not yet observed |
| **Impact** | Dependency resolution may fail |
| **Detection** | state_stamp not found for 3 engines |
| **Recovery** | Start all engines |
| **Priority** | 2 |
| **Estimated Fix Time** | 15 minutes |
| **Steps** | 1. Start audit_engine |
| | 2. Start watchlist_target_engine |
| | 3. Check remaining unknown engine |
| | 4. Verify all state_stamps present |

## 32.3 Gap Summary
| # | Gap | Severity | Priority | Status |
|---|-----|----------|----------|--------|
| 1 | sqareoff_engine DEGRADED | HIGH | 1 | 🔴 Open |
| 2 | audit_engine UNKNOWN | HIGH | 1 | 🔴 Open |
| 3 | watchlist_target_engine UNKNOWN | MEDIUM | 2 | 🟡 Open |
| 4 | 3 engines not reporting state_stamp | MEDIUM | 2 | 🟡 Open |

## 32.4 Gap Resolution Timeline

### Immediate (0-15 minutes)
- [ ] Resolve sqareoff_engine DEGRADED (reconciliation + restart)
- [ ] Start audit_engine
- [ ] Verify audit_log collection populated

### Short-term (15-30 minutes)
- [ ] Initialize watchlist_target_engine
- [ ] Start remaining unknown engine(s)
- [ ] Verify all 15 engines reporting state_stamps

### Verification (30-45 minutes)
- [ ] All 15 engines RUNNING
- [ ] All state_stamps present
- [ ] sqareoff_engine back to MONITORING
- [ ] audit_engine logging events
- [ ] watchlist_target_engine operational

## 32.5 Gap Impact Matrix
| Component | Before Gaps | After Gaps | Recovery |
|-----------|-------------|------------|----------|
| Core trading | Full | Full (no impact) | ✅ N/A |
| Market data | Full | Full (no impact) | ✅ N/A |
| Order execution | Full | Full (no impact) | ✅ N/A |
| Risk management | Full | Full (no impact) | ✅ N/A |
| Margin management | Full | Full (no impact) | ✅ N/A |
| End-of-day squareoff | Full | DEGRADED | ⚠️ sqareoff_engine |
| Audit trail | None | Not yet | ❌ audit_engine |
| Watchlist+Target | Partial | Not complete | ❌ watchlist_target_engine |

## 32.6 Notes
- **4 gaps identified** in total
- **2 HIGH severity** (sqareoff_engine, audit_engine)
- **2 MEDIUM severity** (watchlist_target_engine, state_stamps)
- **Core trading fully operational** - gaps affect edge cases
- **All gaps are recoverable** without code changes
- **Estimated total fix time**: 30-45 minutes

---
*Architecture gaps analysis based on observed runtime state vs approved architecture.*
