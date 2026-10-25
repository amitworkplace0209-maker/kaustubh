# KAUSTUBH PROJECT - AI DEVELOPMENT RULES

Version: 1.0

These rules are mandatory.

If any instruction conflicts with these rules, stop and report the conflict before making changes.

---

# 1. ALWAYS READ THIS FILE

Before doing ANY task:

- Read PROJECT_IMPLEMENTATION_RULE.md completely.
- Follow every rule.
- Never skip this file.

---

# 2. PROJECT GOAL

This project is a production-grade Kotak Neo Trading Platform.

Main objective:

- 100% Python Backend
- Next.js Frontend
- MongoDB Database
- Kotak Neo SDK Integration
- Kotak Neo WebSocket
- PWA Support
- Offline Support
- Zero Runtime Errors

Everything must support the Kotak Neo SDK.

Never break SDK compatibility.

---

# 3. KOTAK NEO FIRST

Every backend change must be compatible with:

Kotak Neo SDK

Never replace the SDK.

Never modify SDK source code.

Never implement unofficial APIs.

Always preserve:

- Login
- TOTP
- Session
- Orders
- Positions
- Holdings
- Funds
- WebSocket
- Quotes
- Search
- Trade APIs

SDK compatibility is the highest priority.

---

# 4. ZERO ERRORS POLICY

Never leave:

Python Errors

Runtime Errors

Import Errors

Circular Imports

Type Errors

Lint Errors

Mongo Errors

WebSocket Errors

Scheduler Errors

API Errors

Unhandled Exceptions

Warnings that indicate broken functionality

Every modification must leave the project cleaner.

---

# 5. VERIFY BEFORE FINISHING

Before saying a task is complete:

Verify imports.

Verify startup.

Verify MongoDB.

Verify Scheduler.

Verify FastAPI.

Verify WebSocket.

Verify APIs.

Verify Frontend.

Verify TypeScript.

Verify Build.

Verify Production Mode.

Never claim success without verification.

---

# 6. NEVER CHANGE FEATURES

Do NOT remove:

Business Logic

Project Features

User Flow

Database Structure

Trading Logic

Order Flow

Project Architecture

unless explicitly requested.

Only fix bugs.

Only improve implementation.

---

# 7. NEVER CHANGE UI WITHOUT PERMISSION

Never redesign UI.

Never change colors.

Never change layouts.

Never change UX.

Unless explicitly instructed.

---

# 8. PWA RULE

Always preserve:

Responsive Design

Mobile Layout

Desktop Layout

Offline Support

Install Prompt

Manifest

Service Worker

---

# 9. PYTHON BACKEND

Node.js backend is deprecated.

Never move logic back into Node.js.

All backend logic belongs inside Python.

---

# 10. TYPESCRIPT

Zero TypeScript errors.

Zero ESLint errors.

Zero build errors.

---

# 11. MONGODB

Never delete data.

Never remove collections.

Never change schemas without explanation.

Never create invalid indexes.

Always verify compatibility.

---

# 12. WEBSOCKET

Never reduce reconnect reliability.

Never remove heartbeat.

Never reduce buffering.

Never reduce performance.

---

# 13. PERFORMANCE

Avoid unnecessary loops.

Avoid duplicate queries.

Avoid duplicate requests.

Avoid duplicate database writes.

Avoid memory leaks.

Prefer async implementations.

---

# 14. SECURITY

Never log:

Passwords

Tokens

MPIN

TOTP Secret

Session IDs

Trade Tokens

Never expose secrets.

---

# 15. CODE WRITING

Never write large code blocks inside chat.

Write code directly into project files.

Only explain changes in chat.

Chat should never become a code editor.

---

# 16. ENGINEERING LOG

Every NEW CHAT must automatically create:

docs/cline/CLINE_CHAT_XXX.md

Example:

CLINE_CHAT_001.md

CLINE_CHAT_002.md

CLINE_CHAT_003.md

...

Never overwrite previous chat reports.

---

# 17. EVERY CHAT REPORT MUST CONTAIN

Date

Time

Chat Number

Workspace

Branch

Project Version

Objective

Files Read

Files Modified

Commands Executed

Errors Found

Root Cause

Fixes Applied

Verification

Remaining Bugs

TODO

Next Steps

AI Notes

Time Spent

Risk Assessment

---

# 18. UPDATE INDEX

Always update:

docs/cline/INDEX.md

Include:

Chat Number

Date

Topic

Status

Summary

---

# 19. BEFORE MODIFYING ANY FILE

Inspect:

Current implementation

Dependencies

Import chain

Side effects

Performance impact

SDK compatibility

Never modify blindly.

---

# 20. DEBUGGING RULE

Always fix root cause.

Never suppress exceptions.

Never hide errors.

Never ignore warnings.

Never use temporary hacks.

Never add unnecessary try/except blocks.

---

# 21. DOCUMENTATION

Every architecture change requires:

Migration report

Verification report

Reason

Risk

Rollback strategy

---

# 22. FILE ORGANIZATION

Never create random files.

Place files in proper folders.

Keep the project organized.

---

# 23. GIT

Never force push.

Never delete branches.

Never rewrite history without permission.

---

# 24. AI BEHAVIOR

Think before modifying.

Inspect first.

Understand architecture.

Trace dependencies.

Then modify.

Then verify.

Then document.

---

# 25. COMPLETION RULE

A task is NOT complete until:

Project builds.

Backend starts.

Frontend starts.

MongoDB works.

Scheduler works.

WebSocket works.

Kotak SDK works.

No runtime errors exist.

Documentation updated.

Chat report generated.

INDEX updated.

Only then declare the task complete.