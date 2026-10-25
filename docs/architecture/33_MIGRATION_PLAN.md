**STATUS: MIGRATED 2026-09-23 � 4-WS model (WebSocket_ConnectionManager_Flow.md + 08_WEBSOCKET_ARCHITECTURE.md). Dual description WS#1+WS#2 collapsed; now WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend. See 08/09 for canonical flows.**

# 33_MIGRATION_PLAN.md - Migration Roadmap

## 33.1 Migration Overview
This document outlines the prioritized migration roadmap for bringing the KAUSTUBH trading terminal from current state to full target architecture.

## 33.2 Migration Phases

### Phase A: Critical Fixes (0-30 minutes)
| Step | Action | Engine | Expected Outcome |
|------|--------|--------|-------------------|
| A1 | Run position reconciliation | sqareoff_engine | Position data consistent |
| A2 | Force sync positions from MongoDB | sqareoff_engine | All positions synced |
| A3 | Restart sqareoff_engine | sqareoff_engine | State → MONITORING |
| A4 | Start audit_engine | audit_engine | Audit trail active |
| A5 | Verify audit_log collection populated | audit_engine | Compliance logging |

### Phase B: Feature Completion (30-60 minutes)
| Step | Action | Engine | Expected Outcome |
|------|--------|--------|-------------------|
| B1 | Initialize watchlist_target_engine | watchlist_target_engine | Composite engine running |
| B2 | Start remaining unknown engine(s) | Unknown engine(s) | All engines RUNNING |
| B3 | Verify all 15 state_stamps present | All engines | Dependency resolution healthy |
| B4 | Verify sqareoff_engine state | sqareoff_engine | MONITORING |

### Phase C: Full Verification (60-90 minutes)
| Step | Action | Expected Outcome |
|------|--------|-------------------|
| C1 | All 15 engines RUNNING | Full system operational |
| C2 | All state_stamps present | Dependency graph healthy |
| C3 | sqareoff_engine MONITORING | Squareoff fully functional |
| C4 | audit_engine logging | Compliance audit active |
| C5 | watchlist_target_engine operational | Composite feature complete |
| C6 | End-to-end order test | Full trading cycle verified |

## 33.3 Migration Commands
```bash
# Phase A: Critical Fixes
python -m kaushub.engine diagnose sqareoff_engine
python -m kaushub.engine reconcile positions
python -m kaushub.engine sync positions
python -m kaushub.engine restart sqareoff_engine
python -m kaushub.engine start audit_engine
python -m kaushub.engine status sqareoff_engine
python -m kaushub.engine status audit_engine

# Phase B: Feature Completion
python -m kaushub.engine start watchlist_target_engine
python -m kaushub.engine status watchlist_target_engine
python -m kaushub.engine status  # Check all engines

# Phase C: Verification
python -m kaushub.cli status  # Full system check
python -m kaushub.engine status  # All engine states
```

## 33.4 Rollback Plan
| Scenario | Rollback Action | Impact |
|----------|-----------------|--------|
| sqareoff_engine restart fails | Manual squareoff via UI | Reduced functionality |
| audit_engine fails to start | Retry with diagnostics | No audit trail |
| watchlist_target_engine fails | Disable composite feature | Watchlist/target separate |
| Full migration fails | Revert to last stable snapshot | Core trading still operational |

## 33.5 Migration Risks
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| sqareoff_engine restart fails | Low | High | Manual squareoff fallback |
| audit_engine fails to start | Low | Medium | Retry with diagnostics |
| watchlist_target_engine initialization fails | Medium | Low | Use separate watchlist/target |
| Dependency resolution fails after migration | Low | High | Verify state_stamps before completing |

## 33.6 Migration Success Criteria
- [ ] All 15 engines RUNNING
- [ ] All state_stamps present and consistent
- [ ] sqareoff_engine in MONITORING state
- [ ] audit_engine logging events to MongoDB
- [ ] watchlist_target_engine operational
- [ ] End-to-end order test passes
- [ ] All gap items resolved
- [ ] No new gaps introduced

## 33.7 Post-Migration Verification
| Test | Expected Result | Actual |
|------|-----------------|--------|
| Order placement | ✅ | |
| Order fill confirmation | ✅ | |
| Risk check | ✅ | |
| Margin check | ✅ | |
| Position tracking | ✅ | |
| PnL calculation | ✅ | |
| Squareoff | ✅ | |
| Audit logging | ✅ | |
| WS#1 feeds | ✅ | |
| WS#2 connections | ✅ | |
| Session management | ✅ | |
| Broker failover | ✅ | |

## 33.8 Notes
- **Migration is incremental** - no single-point-of-failure changes
- **Core trading never interrupted** - gaps are edge-case scenarios
- **Rollback plan** available for every phase
- **All migration steps** are reversible
- **Estimated total time**: 30-90 minutes
- **Success criteria** must be met before considering migration complete

---
*Migration plan based on architecture gaps analysis and observed runtime state.*
