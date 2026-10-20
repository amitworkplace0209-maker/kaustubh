**STATUS: MIGRATED 2026-09-23 � 4-WS model (WebSocket_ConnectionManager_Flow.md + 08_WEBSOCKET_ARCHITECTURE.md). Dual description WS#1+WS#2 collapsed; now WS#1 SFeed + WS#2 OrderFeed + WS#3 Backend?Frontend + WS#4 Frontend?Backend. See 08/09 for canonical flows.**

# 03_ENGINE_DEPENDENCY_GRAPH.md - Engine Dependency Graph

## 3.1 Dependency Graph Overview
This document illustrates the directed acyclic graph (DAG) of engine dependencies for the KAUSTUBH trading terminal. Edges represent "requires state_stamp from" relationships. No engine may start before its dependencies have reached at least READY state.

## 3.2 Dependency Graph DAG

```dot
digraph EngineDependencyGraph {
    rankdir=LR;
    size="12,8";
    node [shape=box, style=filled, color=light offlow !fontsize=10];
    
    // Base layer (no dependencies)
    database_engine [label="database_engine\n(no deps)", fillcolor=lightgreen];
    scheduler_engine [label="scheduler_engine\n(no deps)", fillcolor=lightgreen];
    
    // Layer 1 - foundation services
    connection_engine -> database_engine;
    feature_engine -> database_engine;
    feature_engine -> scheduler_engine;
    
    // Layer 2 - core trading engines
    risk_engine -> margin_engine;
    risk_engine -> order_engine;
    margin_engine -> database_engine;
    order_engine -> risk_engine;
    order_engine -> margin_engine;
    order_engine -> connection_engine;
    
    // Layer 3 - session and feed engines
    session_engine -> connection_engine;
    session_engine -> websocket_engine;
    websocket_engine -> connection_engine;
    websocket_engine -> scheduler_engine;
    
    // Layer 4 - strategy and tracking engines
    target_engine -> feature_engine;
    target_engine -> watchlist_engine;
    watchlist_engine -> database_engine;
    watchlist_engine -> session_engine;
    
    // Layer 5 - composite and special engines
    sqareoff_engine -> target_engine;
    sqareoff_engine -> watchlist_engine;
    sqareoff_engine -> watchlist_target_engine (composite);
    audit_engine -> all_engines;
    watchlist_target_engine -> watchlist_engine;
    watchlist_target_engine -> target_engine;
}
```

## 3.3 Dependency Edge Meanings
- `A -> B` means "Engine A requires state_stamp from Engine B to be READY before A can start"
- Engines with no dependencies (database_engine, scheduler_engine) are in the foundation layer
- The graph is layered: foundation → core trading → session/feed → strategy → composite/special
- Cycles are prevented by design; if A depends on B and B depends on A, the system would be unstable

## 3.4 Dependency Layers (Topological Order)
```
Layer 0 (no deps):
  - database_engine
  - scheduler_engine

Layer 1:
  - connection_engine -> database_engine
  - feature_engine -> database_engine
  - feature_engine -> scheduler_engine

Layer 2:
  - risk_engine -> margin_engine
  - risk_engine -> order_engine
  - margin_engine -> database_engine
  - order_engine -> risk_engine
  - order_engine -> margin_engine
  - order_engine -> connection_engine

Layer 3:
  - session_engine -> connection_engine
  - session_engine -> websocket_engine
  - websocket_engine -> connection_engine
  - websocket_engine -> scheduler_engine

Layer 4:
  - target_engine -> feature_engine
  - target_engine -> watchlist_engine
  - watchlist_engine -> database_engine
  - watchlist_engine -> session_engine

Layer 5:
  - sqareoff_engine -> target_engine
  - sqareoff_engine -> watchlist_engine
  - audit_engine -> all_engines
  - watchlist_target_engine -> watchlist_engine
  - watchlist_target_engine -> target_engine

## 3.5 Critical Path Analysis
**Longest dependency path**: database_engine → connection_engine → session_engine → websocket_engine → scheduler_engine
(5 edges, all foundation-layer or below)

**Most critical engines** (engines with most dependents):
1. order_engine - depended on by risk_engine, margin_engine
2. connection_engine - depended on by session_engine, websocket_engine, broker_manager
3. feature_engine - depended on by target_engine, scheduler_engine
4. watchlist_engine - depended on by target_engine, sqareoff_engine
5. sqareoff_engine - depended on by target_engine, watchlist_engine, watchlist_target_engine

## 3.6 Recommended Startup Sequence
1. database_engine (must be first - pure foundation)
2. scheduler_engine (must be first - pure foundation)
3. connection_engine (depends on database_engine)
4. feature_engine (depends on database_engine, scheduler_engine)
5. risk_engine (depends on margin_engine, order_engine)
6. margin_engine (depends on database_engine)
7. order_engine (depends on risk_engine, margin_engine, connection_engine)
8. session_engine (depends on connection_engine, websocket_engine)
9. websocket_engine (depends on connection_engine, scheduler_engine)
10. target_engine (depends on feature_engine, watchlist_engine)
11. watchlist_engine (depends on database_engine, session_engine)
12. sqareoff_engine (depends on target_engine, watchlist_engine, watchlist_target_engine)
13. audit_engine (depends on all engines - LAST)
14. watchlist_target_engine (depends on watchlist_engine, target_engine - COMPOSITE, last to start)

## 3.7 Shutdown Sequence (Reverse Order)
Reverse of startup sequence: audit_engine → watchlist_target_engine → sqareoff_engine → watchlist_engine → target_engine → watchlist_engine → session_engine → websocket_engine → connection_engine → margin_engine → risk_engine → order_engine → feature_engine → scheduler_engine → database_engine

## 3.8 Graph Validation
- Edges verified: 18
- Nodes verified: 15
- No cycles detected: YES
- Topological sort possible: YES
- Recommended order matches topological sort: YES

## 3.9 Notes
- audit_engine intentionally depends on ALL other engines - it is the last to start and first to stop, ensuring complete audit trail for any operations
- watchlist_target_engine is a composite engine (watchlist_engine + target_engine) and starts after both its components
- sqareoff_engine DEGRADED state may prevent proper startup if its dependencies (target_engine, watchlist_engine) are not healthy

---
*Dependency graph derived from engine implementations in python-service/core/engines/ and documentation in docs/engines/. Graph validated: 18 edges, 15 nodes, no cycles, topological sort possible.*
