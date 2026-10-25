# PROJECT IMPLEMENTATION RULE

Version: 1.0
Status: ACTIVE
Scope: Entire Project
Applies To: OpenCode, ChatGPT, Claude, Gemini, Codex, autonomous agents, coding agents, computer-use agents, and any future AI agent working on this project.

---

# 0. PURPOSE

This file defines the mandatory operating rules for every AI agent working on this project.

The objective is:

- preserve the intended architecture
- prevent accidental redesign
- prevent duplicate implementations
- preserve engine responsibilities
- maintain backend/frontend documentation
- track every implementation
- track every verification
- never silently leave unfinished work
- never declare incomplete work complete
- make the project understandable to a future human or AI agent
- maintain a reliable historical record of what was changed, why, how, and what was verified

This document is a PROJECT GOVERNANCE RULE.

Every AI agent must read and follow this file before performing project work.

---

# 1. MANDATORY FIRST ACTION

Before changing ANY code, configuration, database, UI, engine, API, scheduler, WebSocket, or documentation:

READ:

C:\project\PROJECT_IMPLEMENTATION_RULE.md

No implementation may begin before this file has been read.

---

# 2. MANDATORY PROJECT DOCUMENTATION READING ORDER

Before implementing any task, the AI agent MUST inspect the project documentation in the following order.

## STEP 1 — Pending Work

Read:

C:\project\docs\pending\

Read ALL relevant pending files.

The purpose is to determine:

- what work is currently pending
- what was previously unfinished
- what verification is still pending
- what blockers exist
- whether the current task is related to an existing pending task
- whether the current task can safely begin
- whether an existing pending task must be completed first

Do NOT ignore pending work.

Do NOT start a new implementation that conflicts with an existing pending task without analyzing the conflict.

---

# 3. PENDING TASK VERIFICATION RULE

For every pending file:

Determine:

1. What was supposed to be implemented?
2. What was actually implemented?
3. What remains incomplete?
4. What verification remains?
5. Is the pending task currently executable?
6. Are there dependencies/blockers?
7. Is the pending task already fully completed?

If a pending task is already completely implemented AND completely verified:

- update its implementation/verification records if necessary
- only then remove/archive the pending file according to the project's pending-file convention

NEVER delete a pending file merely because code appears to exist.

A pending task may be closed only after verification evidence exists.

If incomplete:

- keep the pending file
- update remaining work
- continue the task if it belongs to the current scope
- otherwise leave it explicitly pending

NO SILENT CLOSURE.

---

# 4. ENGINE SPECIFICATION IS AUTHORITATIVE FOR ENGINE INTENT

Engine specifications are located under:

C:\project\docs\engines\

Each engine should have its own `.md` specification.

Example:

docs/
└── engines/
    ├── MARKET_WATCH.md
    ├── DB_WRITE_ENGINE.md
    ├── RISK_ENGINE.md
    ├── ORDER_ENGINE.md
    └── ...

Before modifying an engine:

READ its complete specification.

The engine specification defines:

- purpose
- responsibilities
- boundaries
- inputs
- outputs
- lifecycle
- ownership
- dependencies
- invariants
- allowed behavior
- prohibited behavior
- expected architecture

An implementation must conform to the engine specification.

---

# 5. DO NOT SILENTLY CHANGE ENGINE RESPONSIBILITY

An AI agent MUST NOT move responsibility from one engine to another merely because it is easier to implement.

Examples:

Do NOT move:

- risk decisions into frontend
- broker access into Market Watch
- database ownership into random engines
- lifecycle scheduling into React
- order placement into UI
- subscription authority into Market Watch if Session Manager owns it
- persistence outside DB Writer when DB Writer is the persistence owner

If a requirement genuinely requires changing engine responsibility:

1. identify the existing responsibility
2. document the conflict
3. update the relevant specification explicitly
4. update affected audits
5. implement the change
6. verify all affected dependencies

---

# 6. BACKEND AUDIT DOCUMENTATION

Backend audit documentation is located under:

C:\project\docs\audits\backend\

Each backend component/engine should have an audit document where applicable.

The backend audit represents:

"WHAT THE SYSTEM CURRENTLY ACTUALLY DOES."

Before modifying backend behavior, read the relevant audit.

Audit information may include:

- current implementation
- actual files
- actual APIs
- current dependencies
- current state
- known defects
- known limitations
- tests
- runtime verification
- unresolved issues

IMPORTANT:

ENGINE SPECIFICATION
=
what the engine SHOULD do

BACKEND AUDIT
=
what the implementation CURRENTLY does

Do not confuse these two.

---

# 7. FRONTEND SPECIFICATION

Frontend specifications are located under:

C:\project\docs\frontend\

The frontend documentation is organized by phase:

docs/
└── frontend/
    ├── phase-1/
    ├── phase-2/
    ├── phase-3/
    ├── phase-4/
    └── ...

Before changing a frontend page/component:

READ the relevant frontend specification.

The specification defines:

- page purpose
- layout
- navigation
- components
- states
- data requirements
- interaction behavior
- realtime behavior
- API behavior
- phase-specific requirements
- UX expectations
- responsive behavior

Do not redesign a documented page without first checking the specification.

---

# 8. BACKEND SPECIFICATION BY PHASE

Backend phase specifications are located under:

C:\project\docs\backend\

Structure:

docs/
└── backend/
    ├── phase-1/
    ├── phase-2/
    ├── phase-3/
    ├── phase-4/
    └── ...

When a task affects phase-specific backend behavior:

READ the relevant phase documentation before implementation.

---

# 9. FRONTEND AUDIT

Frontend audit documentation is maintained separately from frontend specifications.

Relevant audit location:

C:\project\docs\audits\frontend\

The frontend audit describes the CURRENT implementation.

It should record:

- actual route
- actual page/component
- actual UI structure
- actual data source
- actual API
- actual realtime channel
- current state handling
- known UI defects
- missing features
- tests
- verification status
- known limitations

Specification = intended UI.

Audit = current UI.

---

# 10. DO NOT ASSUME DOCUMENTATION IS CURRENT

Documentation must be checked against the actual repository.

If documentation says:

"Feature exists"

but code does not contain it:

record the discrepancy.

If code contains a feature that documentation does not describe:

update the appropriate documentation after verifying the implementation.

Do not blindly trust either documentation or code.

---

# 11. DOCUMENTATION CONSISTENCY RULE

Whenever a feature is:

- created
- modified
- removed
- renamed
- redesigned
- relocated
- enabled/disabled
- merged
- split
- behaviorally changed

the relevant documentation MUST be updated.

Potentially affected documents include:

- engine specification
- backend audit
- frontend specification
- frontend audit
- implementation record
- verification record
- pending task
- architecture documentation
- API documentation
- configuration documentation

Do not leave documentation describing obsolete behavior.

---

# 12. IMPLEMENTATION HISTORY

Create and maintain:

C:\project\docs\implementation\

Every meaningful implementation task must receive a numbered `.md` record.

Example:

docs/
└── implementation/
    ├── 001-architecture-foundation.md
    ├── 002-database-redesign.md
    ├── ...
    ├── 014-market-watch-audit.md
    └── 015-current-task-name.md

Before creating a new implementation record:

1. inspect existing files
2. find the highest existing serial number
3. use the NEXT serial number
4. never reuse an existing serial number
5. never overwrite historical implementation records

Example:

Highest existing number = 014

New task:

015-<topic>.md

---

# 13. IMPLEMENTATION FILE NAMING

Implementation filename format:

NNN-topic-name.md

Examples:

015-market-watch-runtime-window.md

016-mongodb-atlas-migration.md

017-db-write-tick-persistence.md

The topic must describe the actual task.

Do not use meaningless names such as:

015-update.md

015-test.md

015-new.md

---

# 14. IMPLEMENTATION RECORD CONTENT

Every implementation record MUST document:

# Task

What was requested.

# Objective

What the implementation was supposed to achieve.

# Scope

What was included.

# Out of Scope

What was intentionally not changed.

# Source Documentation Read

List:

- pending files
- engine specifications
- backend specifications
- frontend specifications
- backend audits
- frontend audits
- relevant architecture documents

# Existing State

What existed before the change.

# Problems Found

What was wrong, missing, inconsistent, or incomplete.

# Design Decision

What architecture/design was selected and why.

# Files Changed

List every relevant changed file.

# Files Created

List every new file.

# Files Removed

List every deleted file and why.

# Backend Changes

Describe backend implementation.

# Frontend Changes

Describe frontend implementation.

# Database Changes

Describe database/configuration/schema/index changes.

# API Changes

Describe API changes.

# Realtime Changes

Describe WebSocket/event/realtime changes.

# Scheduler/Lifecycle Changes

Describe lifecycle changes.

# Documentation Changes

Describe documentation updates.

# Tests

List tests executed.

# Test Results

Record actual results.

# Verification

Record actual verification evidence.

# Remaining Issues

List anything not completed.

# Pending Work

List what remains.

# Final Status

Use ONLY one of:

- COMPLETE
- PARTIALLY_COMPLETE
- BLOCKED
- IMPLEMENTED_NOT_VERIFIED
- VERIFIED_WITH_LIMITATIONS

Never use "COMPLETE" when verification is incomplete.

---

# 15. VERIFICATION DOCUMENTATION

Create:

C:\project\docs\verification\

Every significant verification activity must have a verification record.

Possible structure:

docs/
└── verification/
    ├── 001-market-watch-live-verification.md
    ├── 002-mongodb-atlas-verification.md
    ├── 003-db-write-engine-verification.md
    └── ...

Verification is NOT the same as implementation.

Implementation answers:

"WHAT DID WE BUILD?"

Verification answers:

"WHAT DID WE ACTUALLY PROVE?"

---

# 16. VERIFICATION RECORD CONTENT

Every verification record should contain:

# Verification ID

Unique serial number.

# Date / Time

When verification occurred.

# Agent

Which AI/human performed it.

# Task / Feature

What was being verified.

# Expected Behavior

What should have happened.

# Verification Method

Examples:

- static code inspection
- unit test
- integration test
- live broker test
- live database test
- UI inspection
- API test
- WebSocket test
- restart test
- failure/recovery test
- manual verification
- automated test

# Environment

Include relevant environment:

- development
- test
- Atlas
- VM
- live market
- market closed
- browser
- backend process
- relevant timezone

Never expose secrets.

# Questions / Checks

List exactly what was checked.

# Expected Results

What should have happened.

# Actual Results

What actually happened.

# Evidence

Record:

- command
- test
- endpoint
- UI state
- logs
- relevant result
- screenshots/reference if applicable

# Problems Found

Every defect found during verification.

# Fixes Applied

What was fixed.

# Re-verification

What was checked again after the fix.

# Final Result

Use:

PASS
FAIL
PARTIAL
BLOCKED
NOT_VERIFIED

# Remaining Risks

List anything not proven.

---

# 17. SCIENTIFIC / FORENSIC VERIFICATION STANDARD

Verification documentation must be understandable to another engineer or AI agent who was NOT present during the original work.

A future agent must be able to determine:

- what was supposed to happen
- what was tested
- how it was tested
- what environment was used
- what actually happened
- what failed
- what was fixed
- what remains uncertain
- whether the result is trustworthy

Never write vague verification statements such as:

"Everything works."

Instead write:

"Expected: Market Watch Engine stops at 15:30 IST.
Actual: Scheduler issued STOP at 15:30:02 IST.
Observed: ranking task cancelled.
Observed: no new Market Watch subscription intent after stop.
Result: PASS."

---

# 18. PENDING WORK LIFECYCLE

Every incomplete task must remain traceable.

Lifecycle:

PENDING
↓
IN_PROGRESS
↓
IMPLEMENTED
↓
VERIFIED
↓
COMPLETE

Possible exception:

PENDING
↓
BLOCKED

A task is NOT complete merely because code exists.

A task is NOT complete merely because tests pass.

A task becomes COMPLETE only when:

- implementation exists
- required tests pass
- required runtime verification is complete
- documentation is updated
- known issues are recorded
- pending work is resolved
- acceptance criteria are satisfied

---

# 19. PENDING FILE CLOSURE

When a pending task is completely finished:

1. verify every pending item
2. update implementation record
3. create/update verification record
4. update relevant specifications/audits
5. confirm no unresolved acceptance criteria
6. only then remove/archive the pending file

If even one material item remains:

DO NOT delete the pending file.

Update it with:

- completed items
- remaining items
- blockers
- next verification

---

# 20. NO FAKE COMPLETION

An AI agent MUST NOT claim:

- complete
- production ready
- fully verified
- live verified
- all tests pass

unless actual evidence supports the statement.

Examples:

"TypeScript passed"

does NOT mean:

"frontend fully verified."

"Unit tests passed"

does NOT mean:

"live broker integration verified."

"MongoDB connection works"

does NOT mean:

"database architecture fully verified."

Always distinguish:

CODE COMPLETE
TEST COMPLETE
RUNTIME VERIFIED
PRODUCTION VERIFIED

---

# 21. NO FAKE DATA

Never create fake production-like data to make the UI appear complete.

Do not fabricate:

- stock prices
- LTP
- volume
- orders
- trades
- positions
- P&L
- broker status
- WebSocket status
- Market Watch rankings
- reports
- database records
- live timestamps

If data is unavailable:

show an honest:

- UNKNOWN
- NO_DATA
- PENDING
- STALE
- OFFLINE
- NOT_VERIFIED

state according to the documented contract.

---

# 22. DATABASE SAFETY

Never perform destructive database operations without explicit authorization.

Do NOT automatically execute:

- dropDatabase
- collection.drop
- deleteMany on production
- destructive migration
- production reset

Before database changes:

1. inspect current database
2. identify environment
3. identify database
4. identify collections
5. identify indexes
6. verify backup/migration requirements
7. verify whether the database is production/test/development

Never expose database credentials.

---

# 23. ENVIRONMENT / SECRET SAFETY

Never write secrets into:

- source code
- documentation
- implementation records
- verification records
- screenshots
- logs
- Git
- README
- test fixtures

Never print:

- passwords
- API keys
- broker secrets
- MongoDB credentials
- JWT secrets
- private tokens

Use redacted values.

---

# 24. ARCHITECTURE-FIRST RULE

Before implementing a feature:

Understand:

- owner
- data source
- lifecycle
- dependencies
- API
- realtime channel
- database ownership
- frontend consumer
- error behavior
- test strategy

Do not start by modifying the first file that appears relevant.

Trace the complete flow first.

---

# 25. TRACE BEFORE CHANGE

For every significant feature, trace:

INPUT
↓
OWNER
↓
PROCESSING
↓
STATE
↓
EVENT
↓
API / REALTIME
↓
FRONTEND
↓
PERSISTENCE
↓
VERIFICATION

Document the flow when necessary.

---

# 26. NO DUPLICATE ENGINES

Before creating a new engine, scanner, scheduler, manager, service, repository, or background worker:

Search the entire repository.

Determine whether an existing implementation already owns the responsibility.

Do not create duplicates merely because an existing implementation is difficult to understand.

Prefer:

- reuse
- refactor
- consolidate
- extend

over:

- duplicate
- parallel
- shadow implementation

---

# 27. NO DUPLICATE UI

Before creating a new page/component:

Search all frontend routes and components.

If the same conceptual feature already exists:

use the canonical implementation.

Do not create:

- PageA
- PageB
- LegacyPage
- PhasePage
- NewPage

for the same feature without a documented architectural reason.

---

# 28. UI DESIGN / FLOW DOCUMENTATION

For every major UI feature, document:

- page structure
- navigation
- user flow
- states
- empty states
- error states
- loading states
- offline states
- realtime behavior
- responsive behavior
- phase behavior
- permissions if applicable

If the project already contains:

- architecture diagram
- flow diagram
- sequence diagram
- design chart
- hero section
- landing page
- dashboard layout
- service page

then maintain it rather than silently replacing it.

---

# 29. DESIGN / HERO / LANDING / SESSION RECORD

When a major page or service is implemented, record:

WHAT WAS DESIGNED
WHAT WAS BUILT
WHAT WAS CONNECTED
WHAT REMAINS
WHAT IS NEXT

This applies to:

- hero sections
- landing pages
- service pages
- dashboards
- session interfaces
- engine pages
- settings pages
- monitoring pages
- architecture diagrams
- workflow diagrams

If a required design/flow artifact does not exist:

create it when it is part of the documented scope.

Do not create decorative documentation that has no engineering value.

---

# 30. "WHAT EXISTS / WHAT IS MISSING / WHAT IS NEXT"

Every major implementation record should contain:

## Existing

What is already implemented.

## Completed

What this task completed.

## Missing

What remains absent.

## Pending

What is waiting for future work or verification.

## Next

What should logically happen next.

This section is mandatory for major tasks.

---

# 31. CURRENT STATE MUST ALWAYS BE EXPLICIT

At the end of a task, the AI agent must be able to answer:

"What is the exact current state of this feature?"

Possible states:

- SPECIFIED
- IMPLEMENTED
- TESTED
- RUNTIME_VERIFIED
- PARTIALLY_IMPLEMENTED
- BLOCKED
- PENDING
- COMPLETE

Never leave the project in an ambiguous state.

---

# 32. CHANGE IMPACT ANALYSIS

Before modifying shared infrastructure, identify affected systems.

For example:

Changing:

DB Writer

may affect:

- Market Watch
- Watchlist
- Order
- Audit
- Storage
- Notification
- database
- realtime observability

Changing:

Session Manager

may affect:

- WebSocket Engine
- subscriptions
- Market Watch
- Watchlist
- Order Engine
- broker lifecycle

Changing:

Connection Manager

may affect:

- frontend realtime
- commands
- notifications
- status pages
- Market Watch

Perform impact analysis before implementation.

---

# 33. TESTING RULE

Testing must match the risk.

For a code-only change:

- unit tests
- type checks
- lint

For backend integration:

- integration tests
- database tests where appropriate

For WebSocket changes:

- connection
- reconnect
- duplicate subscription
- event delivery
- lifecycle

For UI changes:

- TypeScript
- lint
- route verification
- actual rendering
- interaction verification

For broker changes:

- runtime broker verification

For database changes:

- connection
- schema/collection
- indexes
- read/write
- failure/reconnect
- environment isolation

---

# 34. LIVE VERIFICATION RULE

If a feature requires a real external system to verify:

DO NOT claim full verification without that system.

Examples:

MongoDB Atlas
Broker API
Broker WebSocket
Live Market
Production-like environment

Use:

IMPLEMENTED_NOT_VERIFIED

or:

VERIFIED_WITH_LIMITATIONS

when appropriate.

---

# 35. COMPUTER-USE / AGENT EXECUTION RULE

When an AI agent uses a browser, terminal, filesystem, or computer-use capability:

Before performing an action:

1. identify the target
2. identify the intended result
3. verify the environment
4. perform the smallest safe action
5. inspect the result
6. record meaningful evidence

Do not blindly click through production interfaces.

Do not execute destructive commands without confirmation.

Do not assume a visual UI state proves backend state.

Computer-use verification must distinguish:

UI appearance
from
actual system state.

---

# 36. READING EXISTING WORK IS MANDATORY

Before rewriting any existing implementation:

Read:

- specification
- audit
- implementation history
- pending work
- tests
- relevant code

Do not replace existing code merely because it is large, old, or difficult to understand.

First determine why it exists.

---

# 37. REFACTORING RULE

Refactoring is allowed only when it improves the documented architecture or solves a verified problem.

Do NOT refactor unrelated systems during a feature task.

Do NOT mix:

feature implementation
+
unrelated cleanup
+
architecture redesign
+
dependency upgrades

unless explicitly required.

Keep changes traceable.

---

# 38. REQUIREMENT CHANGE RULE

If the user's new requirement conflicts with an existing specification:

Do NOT silently implement the new behavior.

First identify:

- old requirement
- new requirement
- affected components
- architectural consequences

Then update the authoritative specification if the new requirement is intentionally accepted.

After that:

update implementation
update audit
update implementation record
update verification

---

# 39. DOCUMENTATION UPDATE ORDER

When behavior changes:

1. update authoritative specification if requirement changed
2. implement code
3. update backend audit
4. update frontend audit
5. update implementation record
6. create/update verification record
7. update pending task
8. close pending task only after verification

---

# 40. SERIAL NUMBER RULE

Serial numbers must never be guessed.

Before creating:

implementation/NNN-*.md

or:

verification/NNN-*.md

inspect existing files and calculate:

MAX(existing serials) + 1

If serial 014 is the highest:

next = 015

If 015 already exists:

do not overwrite it.

Use the next unused serial number.

---

# 41. CURRENT CHAT IMPLEMENTATION RECORD

Every substantial working session must leave an implementation record.

The record must summarize:

- task requested in the chat
- requirements extracted
- files inspected
- documentation read
- implementation performed
- architecture decisions
- tests
- verification
- problems found
- problems fixed
- remaining work
- next steps

Do not rely on chat history as the permanent project record.

The repository documentation is the durable record.

---

# 42. CHAT DATA MUST NOT BE LOST

When the task is complete, important decisions made during the chat must be transferred into:

- specification
- audit
- implementation
- verification
- pending

as appropriate.

The project must remain understandable even if the chat history disappears.

---

# 43. FINAL TASK CHECKLIST

Before declaring a task complete, verify:

[ ] PROJECT_IMPLEMENTATION_RULE.md read

[ ] Pending files read

[ ] Relevant engine specification read

[ ] Relevant backend specification read

[ ] Relevant frontend specification read

[ ] Relevant backend audit read

[ ] Relevant frontend audit read

[ ] Existing implementation inspected

[ ] Architecture ownership identified

[ ] Dependencies identified

[ ] No duplicate implementation created

[ ] No unauthorized responsibility transfer

[ ] No fake data

[ ] No secret leakage

[ ] Tests executed

[ ] Actual test results recorded

[ ] Runtime verification performed if required

[ ] Documentation updated

[ ] Implementation record created

[ ] Verification record created if required

[ ] Pending work updated

[ ] Remaining problems explicitly documented

[ ] Next steps documented

[ ] Final status accurately classified

---

# 44. DEFINITION OF COMPLETE

A task is COMPLETE only when all applicable requirements are satisfied.

Minimum definition:

IMPLEMENTED
+
TESTED
+
VERIFIED
+
DOCUMENTED
+
NO UNRESOLVED ACCEPTANCE CRITERIA
+
PENDING TASK CLOSED

If any required part is missing:

the task is NOT COMPLETE.

Use the appropriate incomplete status.

---

# 45. DEFINITION OF HIGH-QUALITY IMPLEMENTATION

High quality means:

- correct architecture
- correct ownership
- minimal duplication
- deterministic behavior
- observable behavior
- tested behavior
- verified behavior
- documented behavior
- safe failure behavior
- maintainable code
- clear lifecycle
- clear data flow
- clear UI state
- reproducible verification
- future-agent-readable documentation

"Looks good" is not a verification standard.

---

# 46. AGENT FINAL RESPONSE FORMAT

At the end of every substantial implementation task, the AI agent must report:

## 1. Direct Result

What was actually completed.

## 2. Files Changed

Exact files.

## 3. Architecture Changes

What changed architecturally.

## 4. Documentation Read

What documentation was used.

## 5. Documentation Updated

What documentation changed.

## 6. Tests

Actual commands and results.

## 7. Verification

What was actually verified.

## 8. Problems Found

Actual problems.

## 9. Problems Fixed

Actual fixes.

## 10. Remaining

Anything incomplete or uncertain.

## 11. Pending

Tasks still open.

## 12. Next Step

The next logical implementation/verification action.

## 13. Final Status

One of:

COMPLETE
PARTIALLY_COMPLETE
BLOCKED
IMPLEMENTED_NOT_VERIFIED
VERIFIED_WITH_LIMITATIONS

---

# 47. ABSOLUTE RULE

When uncertain:

DO NOT GUESS.

Read more documentation.
Inspect the implementation.
Trace the architecture.
Run the relevant test.
Verify the actual state.
Document the uncertainty.

The goal is not to produce the fastest code.

The goal is to maintain a correct, traceable, verifiable, high-quality project.

---
# 48. DOCUMENTATION, LOGGING & FILE ORGANIZATION RULE

This rule is mandatory for every AI agent working on the project.

The project documentation root is:

C:\project\docs\

All project documentation, implementation records, verification records, pending records, audit records, specifications, and logs MUST remain organized under this documentation system.

Do NOT create random `.md`, `.log`, `.txt`, `.json`, or other documentation/log files in arbitrary project directories unless the file is a genuine runtime/application file that technically belongs there.

---

# 49. MANDATORY DOCUMENTATION DIRECTORY STRUCTURE

The AI agent MUST maintain the following documentation structure:

C:\project\docs\

├── pending\
│
├── engines\
│
├── backend\
│   ├── phase-1\
│   ├── phase-2\
│   ├── phase-3\
│   ├── phase-4\
│   └── ...
│
├── frontend\
│   ├── phase-1\
│   ├── phase-2\
│   ├── phase-3\
│   ├── phase-4\
│   └── ...
│
├── audits\
│   ├── backend\
│   └── frontend\
│
├── implementation\
│
├── verification\
│
└── logs\

If any required directory does not exist:

CREATE IT.

Do NOT assume the directory exists.

Before creating a file:

1. verify the parent directory exists
2. create it if missing
3. inspect existing files
4. determine the correct naming/index
5. create the new file in the correct location

---

# 50. LOG DIRECTORY RULE

ALL PROJECT IMPLEMENTATION/ENGINEERING LOGS MUST BE STORED UNDER:

C:\project\docs\logs\

Do NOT create project logs in:

- C:\project\
- random engine directories
- random service directories
- Desktop
- temporary folders
- arbitrary documentation locations

unless they are actual application runtime logs required by the application itself.

The distinction is:

ENGINEERING / IMPLEMENTATION LOG
→ C:\project\docs\logs\

APPLICATION RUNTIME LOG
→ existing application's designated runtime log location

Do not mix these two.

---

# 51. LOG TYPES

The `docs/logs/` directory may contain categorized logs such as:

docs/
└── logs/
    ├── implementation/
    ├── verification/
    ├── migration/
    ├── database/
    ├── broker/
    ├── frontend/
    ├── backend/
    ├── architecture/
    └── runtime/

Create a category only when there is a real need.

Do NOT create empty folders just for appearance.

If the project already has an established log category, reuse it.

---

# 52. LOG FILE NAMING

Every engineering log MUST have deterministic naming.

Preferred format:

NNN-YYYYMMDD-topic-name.md

Example:

001-20260928-market-watch-runtime.md

002-20260928-mongodb-atlas-migration.md

003-20260928-db-write-engine.md

The serial number is mandatory for ordered engineering logs.

The date is mandatory when the log represents a specific work session/event.

The topic must describe the actual work.

Do NOT use:

log1.md
new.md
test.md
update.md
final.md
latest.md
temp.md

---

# 53. LOG SERIAL NUMBER RULE

Before creating a new log:

1. inspect the relevant logs directory
2. identify all existing serial numbers
3. find the highest valid serial number
4. use the next available serial number
5. never overwrite an existing log
6. never reuse a serial number

Example:

Existing:

001-...
002-...
003-...
014-...

Next:

015-...

If `015` already exists:

DO NOT overwrite it.

Use the next unused serial number.

---

# 54. DOCUMENT SERIAL NUMBER RULE

The same principle applies to:

- implementation files
- verification files
- audit records
- migration records
- pending records
- logs

Never guess a serial number.

Always inspect the directory first.

Serial numbers are permanent historical identifiers.

---

# 55. FILE NAMING STANDARD

All documentation files must use clear, deterministic names.

Preferred:

NNN-topic-name.md

or, when date is required:

NNN-YYYYMMDD-topic-name.md

Examples:

015-market-watch-runtime-window.md

016-mongodb-atlas-database-redesign.md

017-db-write-tick-persistence.md

018-market-watch-offline-state.md

Avoid:

new.md
update.md
fix.md
notes.md
final.md
latest.md
temp.md
working.md

The filename must allow a future AI agent to understand the purpose without opening the file.

---

# 56. INDEXING RULE

Indexing MUST remain sequential and traceable.

Before creating any numbered documentation file:

SEARCH the target directory.

Determine:

MAXIMUM EXISTING INDEX + 1

Use that value.

Do NOT rely on memory.

Do NOT assume the last number from chat history.

The filesystem is the source of truth for numbering.

---

# 57. DUPLICATE FILE PREVENTION

Before creating a new documentation/log file:

Search for:

- same topic
- similar filename
- existing implementation record
- existing verification record
- existing pending record

If an existing document already covers the same task:

UPDATE the existing document when appropriate.

Do NOT create duplicate documentation simply because the AI forgot that an earlier file exists.

If a new record is genuinely required:

create a new sequential record and reference the previous record.

---

# 58. CROSS-REFERENCE RULE

When documentation is related to another document, include explicit references.

Example:

Related Specification:
docs/engines/MARKET_WATCH.md

Related Audit:
docs/audits/backend/market-watch-audit.md

Related Implementation:
docs/implementation/015-market-watch-runtime-window.md

Related Verification:
docs/verification/015-market-watch-runtime-window.md

Related Pending:
docs/pending/market-watch-live-verification.md

This allows a future AI agent to trace the complete history.

---

# 59. DOCUMENTATION CHANGE LOG

When a specification or audit file is materially changed, update its internal change history when the file supports one.

Recommended format:

## Change History

| Version | Date | Change | Agent |
|---|---|---|---|
| 1.0 | YYYY-MM-DD | Initial | AI/Human |
| 1.1 | YYYY-MM-DD | Updated runtime behavior | AI/Human |

Do not fabricate historical entries.

Only record changes that actually happened.

---

# 60. LOG CONTENT STANDARD

Every meaningful engineering log must answer:

1. What task was being performed?
2. Why was it performed?
3. What documentation was read?
4. What was the starting state?
5. What was inspected?
6. What was changed?
7. Why was it changed?
8. What files were affected?
9. What tests were executed?
10. What verification was performed?
11. What problems were found?
12. What problems were fixed?
13. What remains?
14. What is the next step?
15. What is the final status?

Do NOT create logs that merely say:

"Updated project."

Logs must preserve engineering context.

---

# 61. COMMAND / EVIDENCE LOGGING

When an important verification or implementation depends on a command:

record:

Command:
<actual command>

Expected:
<expected result>

Actual:
<actual result>

Status:
PASS / FAIL / PARTIAL / BLOCKED

Do not record commands that were not actually executed.

Do not fabricate output.

---

# 62. AI AGENT SESSION LOG

For every substantial implementation session, create/update an engineering session log under:

C:\project\docs\logs\

The log should record:

- session date
- task
- agent
- documentation read
- files inspected
- decisions
- implementation
- tests
- verification
- problems
- pending items
- final state

The session log is a historical record.

It must remain understandable without the original chat.

---

# 63. DO NOT USE CHAT AS PROJECT STORAGE

Chat history is temporary context.

The repository documentation is the permanent project record.

Important information from the chat must be transferred into the appropriate:

- specification
- audit
- implementation
- verification
- pending
- log

file.

Do NOT assume another AI agent will have access to this chat.

---

# 64. MISSING FOLDER AUTO-CREATION

If a required documentation folder does not exist:

the AI agent MUST create it before continuing.

Examples:

If:

C:\project\docs\logs\

does not exist:

CREATE:

C:\project\docs\logs\

If:

C:\project\docs\verification\

does not exist:

CREATE:

C:\project\docs\verification\

If:

C:\project\docs\audits\backend\

does not exist:

CREATE:

C:\project\docs\audits\backend\

Do not fail simply because a documentation directory is missing.

---

# 65. DO NOT CREATE RANDOM DOCUMENTATION LOCATIONS

The following is prohibited:

C:\project\random-notes.md

C:\project\backend-notes.md

C:\project\market-watch-log.md

C:\project\temp\audit.md

C:\project\services\notes.md

when the document belongs to project documentation.

Instead place it under the appropriate:

C:\project\docs\

subdirectory.

---

# 66. DOCUMENT TYPE ROUTING

Before creating a file, determine its type.

If it describes:

WHAT SHOULD EXIST
→ specification

WHAT CURRENTLY EXISTS
→ audit

WHAT WAS IMPLEMENTED
→ implementation

WHAT WAS VERIFIED
→ verification

WHAT IS NOT YET COMPLETE
→ pending

WHAT HAPPENED DURING THE WORK SESSION
→ log

Do not use one file type as a replacement for another.

---

# 67. IMPLEMENTATION + VERIFICATION + LOG RELATIONSHIP

For every substantial task:

IMPLEMENTATION
    ↓
docs/implementation/NNN-topic.md

VERIFICATION
    ↓
docs/verification/NNN-topic.md

SESSION / ENGINEERING HISTORY
    ↓
docs/logs/NNN-YYYYMMDD-topic.md

PENDING
    ↓
docs/pending/topic.md

All related records must cross-reference each other where applicable.

---

# 68. FINAL DOCUMENTATION SYNCHRONIZATION

Before declaring a task COMPLETE:

verify:

[ ] correct specification updated
[ ] backend audit updated if affected
[ ] frontend audit updated if affected
[ ] implementation record created/updated
[ ] verification record created/updated
[ ] pending record updated/closed
[ ] engineering log created/updated
[ ] filenames follow naming standard
[ ] serial numbers are correct
[ ] no duplicate records exist
[ ] cross-references are valid
[ ] no random documentation files were created
[ ] no secrets were written

Only after this synchronization may the task be marked COMPLETE.

---

# 69. DOCUMENTATION DIRECTORY IS A CONTROLLED SYSTEM

Treat:

C:\project\docs\

as a controlled engineering documentation system.

Do not casually rename, move, delete, or reorganize documentation.

Before structural changes:

1. inspect references
2. inspect links
3. inspect code references
4. inspect other documentation
5. update references
6. verify no broken references remain

---

# 70. FINAL RULE

The documentation system must always allow a future AI agent to answer:

- What is this project?
- What should each engine do?
- What does it currently do?
- What should the frontend look like?
- What does the frontend currently do?
- What has already been implemented?
- What has actually been verified?
- What remains pending?
- What happened during previous sessions?
- What should be done next?
- Which documents prove each claim?

If the documentation cannot answer these questions:

the documentation system is incomplete and must be improved.

# 71. OPENCODE WORKING FILES & REFERENCE STORAGE RULE

This rule applies specifically to OpenCode and any AI agent operating through the OpenCode workflow.

---

## 71.1 PURPOSE

During implementation, OpenCode may need to create additional files for:

- detailed analysis
- task breakdown
- implementation planning
- architecture analysis
- investigation
- code inspection
- dependency mapping
- API mapping
- database analysis
- debugging notes
- temporary reference information
- implementation context
- migration planning
- verification preparation
- comparison results
- research notes
- generated checklists
- intermediate technical documentation
- agent handoff information

These files are allowed.

However, they MUST be stored in one controlled location.

---

## 71.2 OPENCODE DIRECTORY

The mandatory OpenCode working-documentation directory is:

C:\project\docs\opencode\

If this directory does not exist:

CREATE IT.

Do not create OpenCode working/reference files elsewhere in the project.

---

## 71.3 FILE STORAGE RULE

Any new file created specifically by OpenCode for its own:

- working context
- analysis
- planning
- investigation
- reference
- implementation notes
- technical notes
- handoff
- temporary structured information
- task breakdown
- architecture mapping

MUST be stored under:

C:\project\docs\opencode\

Example:

C:\project\docs\opencode\001-market-watch-analysis.md

C:\project\docs\opencode\002-mongodb-atlas-investigation.md

C:\project\docs\opencode\003-db-writer-plan.md

---

## 71.4 DO NOT POLLUTE PROJECT ROOT

OpenCode MUST NOT create these files in arbitrary locations:

C:\project\analysis.md
C:\project\notes.md
C:\project\plan.md
C:\project\task.md
C:\project\temp.md
C:\project\research.md

when the file is only an AI working/reference document.

Instead:

C:\project\docs\opencode\

must be used.

---

## 71.5 NUMBERING

Every OpenCode working/reference file MUST use sequential numbering.

Before creating a new file:

1. inspect C:\project\docs\opencode\
2. identify the highest existing serial number
3. select the next available serial number
4. never overwrite an existing file
5. never reuse an existing serial number

Example:

Existing:

001-...
002-...
003-...

Next:

004-topic-name.md

The filesystem is the source of truth.

Never rely on chat memory for numbering.

---

## 71.6 FILE NAMING

Preferred format:

NNN-topic-name.md

Examples:

001-market-watch-analysis.md
002-market-watch-runtime-plan.md
003-mongodb-atlas-reference.md
004-db-write-engine-analysis.md
005-frontend-phase-audit-notes.md

The filename must clearly describe the content.

Avoid:

new.md
test.md
temp.md
notes.md
latest.md
final.md
working.md
data.md

---

## 71.7 SUBDIRECTORIES

OpenCode may create subdirectories under:

C:\project\docs\opencode\

when the number of files becomes large.

Example:

docs/
└── opencode/
    ├── analysis/
    ├── planning/
    ├── references/
    ├── migrations/
    ├── investigations/
    └── handoff/

However:

Do NOT create unnecessary folders.

If a subdirectory is used, numbering must remain deterministic and documented.

The root OpenCode directory remains:

C:\project\docs\opencode\

---

## 71.8 REFERENCE FILES

If OpenCode needs to save a detailed reference for future work:

save it under:

C:\project\docs\opencode\

The reference must include:

- purpose
- source
- date
- task/context
- relevant files
- relevant decisions
- known limitations
- related documentation
- related implementation record
- related verification record

---

## 71.9 TEMPORARY FILES

If OpenCode creates a temporary technical file that is useful only during the current task:

it should still be created under:

C:\project\docs\opencode\

After the task:

- delete it if it has no future value
- or convert it into a permanent reference if it contains useful project knowledge

Do NOT leave random temporary files scattered throughout the repository.

---

## 71.10 IMPORTANT PROJECT INFORMATION

If an OpenCode working file contains information that is important for future project maintenance, do NOT leave that information only inside the OpenCode directory.

Promote the information into the correct permanent documentation:

Specification
Audit
Implementation
Verification
Pending
or
Log

The OpenCode directory is a working/reference layer.

It is NOT a replacement for official project documentation.

---

## 71.11 RELATIONSHIP WITH PROJECT DOCUMENTATION

Use this separation:

docs/engines/
    = authoritative engine specification

docs/backend/
    = backend specification

docs/frontend/
    = frontend specification

docs/audits/
    = current implementation audit

docs/implementation/
    = permanent implementation history

docs/verification/
    = permanent verification evidence

docs/pending/
    = unfinished work

docs/logs/
    = engineering/session history

docs/opencode/
    = OpenCode working/reference/context files

Do not mix these purposes.

---

## 71.12 CROSS-REFERENCES

Whenever an OpenCode reference file is related to a permanent project document, include the path.

Example:

Related Engine Specification:
docs/engines/MARKET_WATCH.md

Related Audit:
docs/audits/backend/market-watch-audit.md

Related Implementation:
docs/implementation/015-market-watch-runtime-window.md

Related Verification:
docs/verification/015-market-watch-runtime-window.md

---

## 71.13 NO DUPLICATE PERMANENT DOCUMENTATION

Before creating a new OpenCode reference file:

check whether the information already exists in:

- specification
- audit
- implementation
- verification
- pending
- logs

If the information already exists and does not need a working copy:

do NOT create a duplicate.

Create an OpenCode file only when it provides useful working/reference value.

---

## 71.14 SECRET SAFETY

OpenCode working files MUST NOT contain:

- passwords
- API keys
- broker credentials
- MongoDB credentials
- JWT secrets
- private tokens
- session secrets
- private connection strings

Use redacted forms.

Example:

CORRECT:

mongodb+srv://<USER>:<REDACTED>@<CLUSTER>/kaustubh

INCORRECT:

mongodb+srv://username:actual-password@cluster.mongodb.net/kaustubh

---

## 71.15 FILE CREATION CHECKLIST

Before creating an OpenCode working/reference file:

[ ] Confirm file is actually needed
[ ] Check whether information already exists
[ ] Ensure C:\project\docs\opencode\ exists
[ ] Inspect existing serial numbers
[ ] Select next available serial
[ ] Use descriptive filename
[ ] Do not overwrite existing files
[ ] Do not include secrets
[ ] Add relevant cross-references

---

## 71.16 FINAL RULE

Whenever OpenCode needs to create a new file specifically for:

analysis,
planning,
reference,
investigation,
working context,
task breakdown,
technical notes,
migration planning,
debugging notes,
handoff,
or other AI working information,

CREATE THE FILE UNDER:

C:\project\docs\opencode\

and nowhere else.

The OpenCode directory must remain organized, indexed, traceable, and free of secrets.

# END OF OPENCODE WORKING FILES & REFERENCE STORAGE RULE
# END OF DOCUMENTATION, LOGGING & FILE ORGANIZATION RULE

# END OF PROJECT IMPLEMENTATION RULE