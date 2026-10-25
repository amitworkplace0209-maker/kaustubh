# Position Engine — Engine Card

> **engineId**: $(System.Collections.Hashtable.id) | **category**: $(System.Collections.Hashtable.cat) | **version**: 1.0.0

## Purpose
On-demand: position query via the active trading broker adapter.

## Dependencies
- $(System.Collections.Hashtable.deps) 

## Lifecycle (init)
Facade over PositionEngine singleton; app.py lifespan.

## Failure Behaviour
DEGRADED + NOT_AUTHENTICATED when trading broker not logged in (honest).

---

*Part 2 per-engine card · Generated 2026-09-14*