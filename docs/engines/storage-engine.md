STORAGE ENGINE — ADVANCED UI + ENGINE DETAILED DESIGN

1. Executive Definition

Storage Engine is the project's infrastructure-state, runtime-health, resource-monitoring, and storage-observability engine.

Its primary responsibility is to continuously understand and maintain the state of the environment in which the backend is running — whether that environment is a VM, localhost, server, containerized runtime, or another supported deployment environment.

It monitors and exposes:

CPU

RAM

disk/storage

network

system load

host uptime

backend process/runtime

PID

workers/threads

application health

engine health

database/storage connectivity

read/write latency

queues/backlogs

resource capacity

historical snapshots

important infrastructure state changes

Core principle:

Storage Engine observes and records infrastructure/runtime state; it does not become the business-authority engine for orders, positions, P&L, risk, or broker execution.

2. Architectural Position

                 VM / LOCALHOST / SERVER
                          │
                          ↓
                   STORAGE ENGINE
                          │
        ┌─────────────────┼─────────────────┐
        ↓                 ↓                 ↓
   Host Monitor      Runtime Monitor    Storage Monitor
        │                 │                 │
 CPU / RAM / Disk    Process / PID      DB / Disk / Queue
 Network / Load      Threads / Workers  Read / Write
 Uptime / Capacity   Runtime Health     Backlog / Latency
        │                 │                 │
        └─────────────────┼─────────────────┘
                          ↓
                    State Collector
                          ↓
                    Normalization
                          ↓
               Current State + History
                          │
            ┌─────────────┼─────────────┐
            ↓             ↓             ↓
       System UI    Notification     Diagnostics
                         Engine

3. Responsibility Boundary

Storage Engine owns

host resource monitoring

runtime monitoring

backend process state

CPU/RAM/disk/network metrics

system load

uptime

process health

thread/worker state

application runtime health

engine heartbeat/health state

database/storage connectivity metrics

read/write latency metrics

queue/backlog metrics

resource capacity

infrastructure snapshots

infrastructure history

storage-health events

infrastructure-health API/feed

monitoring configuration

metric retention policy

Storage Engine does NOT own

order execution

risk decisions

P&L calculation

position authority

broker login

broker execution

trading strategy

AI decisions

notification policy

audit ownership

frontend rendering

It provides infrastructure truth to the rest of the system.

4. Deployment Agnostic Model

The engine must not assume that the backend always runs on a VM.

Supported environments may include:

LOCALHOST
VM
SERVER
CONTAINER
CLOUD_RUNTIME

Environment metadata:

environment_type
hostname
instance_id
container_id
process_id
runtime
runtime_version
os
architecture
timezone
start_time
uptime

The UI should clearly show where the backend is currently running.

5. Host Resource Monitoring

Storage Engine should collect:

CPU

current utilization

user CPU

system CPU

idle CPU

load average where supported

logical CPU count

physical CPU count where available

per-core utilization where useful

CPU frequency where available

RAM

total

used

available

free

cached/buffered where available

utilization percentage

swap total

swap used

swap utilization

Disk

filesystem

total capacity

used

free

utilization

read bytes

write bytes

I/O operations where available

I/O latency where available

Network

interface

state

received bytes

transmitted bytes

packets

errors

drops

active connections where available

latency measurements for configured endpoints

6. CPU State

Example:

CPU
────────────────────
Usage       34%
User        22%
System       8%
Idle        66%

Cores        8
Load 1m     1.42
Load 5m     1.18
Load 15m    0.92

CPU state should be sampled at a controlled interval.

The engine must not create excessive monitoring overhead.

7. RAM State

Example:

RAM
────────────────────
Total       16 GB
Used         9.2 GB
Available    6.8 GB
Usage       57%

Swap
Total        4 GB
Used       120 MB
Usage        3%

RAM thresholds should be configurable.

Example conceptual states:

NORMAL
WARNING
CRITICAL

A short spike should not necessarily produce a critical alert.

Thresholds may use both:

percentage
+
minimum duration

8. Disk State

Storage monitoring must cover the actual filesystems used by the backend.

Example:

Disk
────────────────────────
/              48% used
/project       52% used
/data          61% used

Important thresholds:

WARNING  ≥ configured percentage
CRITICAL ≥ configured percentage

Disk monitoring should also detect:

filesystem unavailable

write failure

read failure

permission failure

abnormal I/O latency

9. Backend Runtime Monitoring

Storage Engine monitors the backend process itself.

Example:

Backend Runtime
────────────────────────

Status       RUNNING
PID          4821
Uptime       06h 42m
Runtime      Python
Version      3.x
Workers      8
Threads      24
Memory       1.8 GB
CPU          12%

Additional state where available:

process start time

process CPU

process memory

thread count

open file descriptors

worker health

event-loop responsiveness

process restart count

10. Application Health

Storage Engine should maintain application-level health separately from host health.

Example:

Host:
NORMAL

Backend:
RUNNING

Application:
DEGRADED

Reason:
Database latency elevated

A healthy VM does not necessarily mean a healthy application.

11. Engine Health Monitoring

Every registered/observable engine should expose or receive a health/heartbeat state.

Example:

Feature Engine       RUNNING
Search Engine        RUNNING
Market Watch         RUNNING
Order Engine         RUNNING
Risk Engine          RUNNING
WebSocket Engine     DEGRADED
Notification Engine  RUNNING
Storage Engine       RUNNING

Possible states:

STARTING
RUNNING
DEGRADED
STOPPED
ERROR
UNKNOWN

For on-demand engines:

NOT_ACTIVE

may be more accurate than STOPPED.

12. Engine Heartbeat

Where supported, an engine can emit:

engine_id
status
timestamp
last_success
last_error
version
uptime
metrics

Storage Engine maintains the latest known state.

Important:

Storage Engine should not falsely mark an engine healthy merely because the process exists.

Health should consider the engine's actual heartbeat/health signal when available.

13. Database / Storage Monitoring

Storage Engine should monitor the persistence layer used by the backend.

Metrics:

connection state

connection latency

read latency

write latency

operation errors

queue size

backlog

pending writes

failed writes

retry count

storage capacity

database availability

Example:

MongoDB
────────────────
Status       CONNECTED
Read         8 ms
Write       12 ms
Backlog      0
Errors       0

14. Storage Pipeline Health

For a write pipeline:

Application Event
      ↓
Buffer / Queue
      ↓
DB Writer
      ↓
Storage

Storage Engine should expose:

queue_depth
oldest_item_age
pending_writes
write_rate
failure_rate
last_success
last_failure

This helps identify a system where the database is technically connected but persistence is falling behind.

15. Queue / Backlog Monitoring

Example:

Write Queue
──────────────
Depth             124
Oldest Item       2.4 sec
Write Rate        80/sec
Failure Rate      0.2%

Thresholds can generate infrastructure notifications.

16. Network Monitoring

Monitor relevant interfaces and configured endpoints.

Example:

Network
────────────────────
eth0          UP
RX            18 MB/s
TX             4 MB/s
Errors         0
Drops          0

For application endpoints:

Broker API     42 ms
Database       8 ms
Frontend WS    11 ms

Network monitoring must distinguish:

local interface health
vs
remote endpoint latency

17. Uptime

Track:

host_uptime
backend_uptime
engine_uptime
database_connection_uptime

Example:

Host Uptime      4d 12h
Backend Uptime   18h 42m
WS Engine        7h 21m

A backend restart must not be confused with a host reboot.

18. State Model

Storage Engine should maintain a normalized infrastructure state.

Conceptual:

InfrastructureState
├── environment
├── host
│   ├── cpu
│   ├── memory
│   ├── disk
│   ├── network
│   └── uptime
│
├── runtime
│   ├── process
│   ├── pid
│   ├── workers
│   ├── threads
│   └── health
│
├── engines[]
│
├── database
├── queues
├── application
└── timestamps

19. Current State vs Historical State

Two separate concepts:

Current State

Latest infrastructure condition.

CPU = 34%
RAM = 57%
Disk = 48%

Historical State

Time-series/snapshots.

10:00 CPU 32%
10:01 CPU 41%
10:02 CPU 38%

The UI should query current state for dashboards and historical state for charts/diagnostics.

20. Snapshot Strategy

Do not persist every raw metric at an uncontrolled frequency.

Recommended conceptual levels:

REALTIME

for current UI state.

SHORT_INTERVAL SNAPSHOT

for recent diagnostics.

AGGREGATED HISTORY

for long-term trends.

Example:

Realtime:
latest state

Recent:
1-minute snapshots

Long-term:
5-minute / hourly aggregates

Exact intervals should be configurable.

21. Retention

Retention should be configurable.

Example:

Realtime state       current only
Recent snapshots     24h
Detailed history     7d
Aggregated history   30d+

Do not assume these durations are mandatory; deployment requirements may change them.

22. Infrastructure Events

Meaningful infrastructure events should be emitted.

Examples:

HOST_CPU_HIGH
HOST_MEMORY_HIGH
DISK_SPACE_LOW
DISK_SPACE_CRITICAL

BACKEND_STARTED
BACKEND_STOPPED
BACKEND_RESTARTED

ENGINE_DEGRADED
ENGINE_STOPPED
ENGINE_RECOVERED

DATABASE_DISCONNECTED
DATABASE_RECONNECTED
DATABASE_LATENCY_HIGH

WRITE_BACKLOG_HIGH
WRITE_FAILURE

Low-level metric samples remain metrics, not individual notifications.

23. Notification Integration

Storage Engine publishes meaningful events to Notification Engine.

Example:

CPU 35%
→ metric only

CPU 94% for configured duration
→ infrastructure warning

Disk 96%
→ critical notification

Database disconnected
→ critical notification

Notification Engine decides:

severity

delivery channel

cooldown

grouping

phase/global visibility

sound

PWA

Storage Engine does not own notification policy.

24. UI Architecture

Recommended:

System / Infrastructure
├── Overview
├── Host
├── Runtime
├── Engines
├── Storage
├── Network
├── History
├── Events
└── Settings

25. Infrastructure Overview UI

Example:

┌────────────────────────────────────────────┐
│ SYSTEM HEALTH                              │
│ NORMAL                         Updated 2s  │
├────────────────────────────────────────────┤
│ CPU       34%       RAM       57%          │
│ Disk      48%       Network   18ms         │
│                                            │
│ Backend   RUNNING    PID 4821              │
│ Uptime    06h 42m                          │
│                                            │
│ Engines   17 Running / 1 Degraded          │
│ Database  CONNECTED                         │
│ Queue     0                                 │
└────────────────────────────────────────────┘

All values must come from backend state.

No hard-coded/fake infrastructure values.

26. Host Page

Sections:

CPU
Memory
Disk
Network
Load
Uptime

Charts:

CPU over time

RAM over time

disk usage trend

network throughput

load trend

Charts should support time ranges.

27. Runtime Page

Show:

Backend Process
PID
Runtime
Version
Start Time
Uptime
CPU
Memory
Threads
Workers
Open Connections

If a metric is unsupported by the deployment environment, show:

Unavailable

not a fabricated value.

28. Engines Page

Table:

Engine
Status
Uptime
Last Heartbeat
Last Success
Last Error
CPU
Memory
Version

Example:

Order Engine       RUNNING
Risk Engine        RUNNING
WebSocket Engine   DEGRADED
Storage Engine     RUNNING

Clicking an engine opens its diagnostics.

29. Engine Detail

Example:

WebSocket Engine

Status:
DEGRADED

Last Heartbeat:
10:58:51

Last Success:
10:58:50

Last Error:
Reconnect attempt 2

Uptime:
7h 21m

Events:
...

This is diagnostic information, not an alternate engine control panel.

30. Storage Page

Show:

Database
Connection
Read Latency
Write Latency
Queue
Backlog
Pending Writes
Failed Writes
Storage Capacity
Last Successful Write
Last Failure

Example:

MongoDB
CONNECTED

Read       8 ms
Write     12 ms
Queue       0
Failures    0

31. Network Page

Show:

Interface
State
RX
TX
Errors
Drops
Latency

Endpoint health:

Broker API
Database
Frontend WebSocket
Other configured services

32. History Page

Time ranges:

5m
15m
1h
6h
24h
7d
Custom

Charts:

CPU

RAM

Disk

Network

backend memory

database latency

queue depth

engine health transitions

33. Events Page

Infrastructure event timeline:

10:55  Database latency high
10:51  WebSocket degraded
10:48  Backend restarted
10:40  Disk warning cleared

Events should be searchable and filterable.

34. Settings

Configurable:

sampling intervals

history retention

CPU thresholds

memory thresholds

disk thresholds

queue thresholds

latency thresholds

health heartbeat timeout

monitored endpoints

enabled metrics

aggregation policy

Dangerous configuration changes should be audited.

35. Threshold Model

A threshold should support:

metric
operator
value
duration
severity
cooldown

Example:

CPU
>= 90%
for 60 seconds
→ WARNING

Another:

Disk
>= 95%
→ CRITICAL

This prevents transient spikes from creating excessive notifications.

36. Health State Calculation

A composite system state may be:

HEALTHY
DEGRADED
CRITICAL
UNKNOWN

But the UI must expose the underlying reasons.

Example:

Overall: DEGRADED

Reasons:
- WebSocket Engine heartbeat delayed
- Database write latency elevated

Do not hide individual component states behind one overall label.

37. Failure Handling

Monitoring failure

If Storage Engine cannot collect a metric:

metric_status = UNAVAILABLE

not zero.

Database failure

Storage Engine should preserve in-memory/current runtime state where possible and expose:

PERSISTENCE_DEGRADED

Permission failure

Example:

Cannot read process metric

should be reported as unavailable with reason.

38. Resource Safety

Monitoring must have a bounded resource footprint.

Requirements:

bounded sampling

no unbounded history in memory

batched persistence

bounded queues

backpressure

metric aggregation

cleanup of stale process/engine records

The monitoring system must not become the reason the backend becomes unhealthy.

39. Security

Infrastructure information is sensitive.

Protect:

hostnames where necessary

internal IP addresses

process details

filesystem paths

database metadata

service endpoints

runtime versions

diagnostic payloads

Never expose:

passwords

API keys

access tokens

broker secrets

database credentials

UI access should be permission-controlled.

40. API / State Contract

Conceptual current-state response:

{
  "environment": {
    "type": "VM",
    "hostname": "backend-node",
    "runtime": "python"
  },
  "host": {
    "cpu": 34,
    "memory": 57,
    "disk": 48,
    "load_1m": 1.42,
    "uptime_seconds": 241200
  },
  "runtime": {
    "status": "RUNNING",
    "pid": 4821,
    "cpu": 12,
    "memory_mb": 1840,
    "threads": 24
  },
  "database": {
    "status": "CONNECTED",
    "read_latency_ms": 8,
    "write_latency_ms": 12,
    "queue_depth": 0
  },
  "engines": [],
  "updated_at": "2026-09-19T10:59:12+05:30"
}

Actual implementation should adapt fields to the supported runtime/environment.

41. Realtime UI Flow

Host / Runtime
      ↓
Storage Engine
      ↓
Normalized State
      ↓
Connection Manager
      ↓
Frontend Store
      ↓
System Dashboard

The frontend must not independently inspect the VM or backend process.

42. Frontend State

Recommended:

infrastructureState
hostState
runtimeState
engineStates
databaseState
networkState
history
events
filters
connectionState
lastUpdated

Updates should be incremental.

A CPU update must not rerender every dashboard module unnecessarily.

43. Storage Engine + DB Writer Relationship

The project may have:

DB Writer Engine

for application-data persistence pipelines.

Storage Engine monitors infrastructure/storage health.

Conceptual separation:

DB Writer
→ writes application records

Storage Engine
→ monitors runtime/storage health

Storage Engine may consume storage-pipeline health metrics without taking over DB Writer's application-data responsibility.

44. Storage Engine + Audit

Important infrastructure events can be sent to Audit Engine.

Examples:

backend restart
configuration change
critical storage failure
engine health transition
security-relevant infrastructure event

Routine metric samples should remain metrics, not audit events.

45. Storage Engine + Notification

Flow:

Storage Engine
      ↓
Meaningful Infrastructure Event
      ↓
Notification Engine
      ↓
Policy
      ↓
UI / Toast / Sound / PWA

Example:

DATABASE_DISCONNECTED
→ Notification Engine
→ CRITICAL
→ System notification
→ Storage page deep link

46. Storage Engine + Scheduler

Scheduler controls lifecycle timing.

Storage Engine observes lifecycle state and runtime health.

It should not independently decide market-session lifecycle.

47. Storage Engine + Broker Terminal

Broker Terminal Engine owns broker connectivity/account state.

Storage Engine may monitor infrastructure-level health:

network latency
backend resource usage
process health

Broker-specific connection truth remains with Broker Terminal Engine.

48. Performance Requirements

The engine should support:

low-overhead host sampling

asynchronous metric collection

batched persistence

efficient time-series queries

indexed current-state access

bounded event queues

configurable retention

incremental UI updates

Monitoring must scale with the number of engines and monitored endpoints.

49. Testing

Unit

CPU collector

memory collector

disk collector

network collector

process collector

threshold evaluation

health calculation

snapshot aggregation

retention

state normalization

Integration

localhost runtime

VM runtime

database disconnected

queue backlog

engine heartbeat failure

network degradation

backend restart

metric unavailable

UI

realtime state

charts

engine table

filters

history

events

unavailable metrics

responsive/mobile layout

50. Failure Scenarios

CPU spike

CPU 95% for 2 sec
→ metric only

CPU 95% for configured duration
→ threshold event

Disk nearly full

Disk 94%
→ warning

Disk 97%
→ critical

Database disconnected

DB disconnected
→ persistence/storage degraded
→ notification
→ UI status

Engine heartbeat lost

Heartbeat timeout
→ engine UNKNOWN/DEGRADED
→ notification according to policy

Backend restart

STOP
→ START
→ new PID
→ uptime reset
→ state recovery

51. Acceptance Criteria

Storage Engine is complete when:

localhost monitoring works

VM monitoring works

deployment type is detected

CPU state is available

RAM state is available

disk state is available

network state is available

uptime is available

backend process state is available

PID/runtime/workers/threads are available where supported

engine health is visible

database/storage health is visible

read/write latency is visible

queue/backlog is visible

current state is persisted/served

historical snapshots are available

configurable retention exists

thresholds are configurable

meaningful infrastructure events reach Notification Engine

important infrastructure events can reach Audit Engine

frontend receives realtime state

unavailable metrics are explicitly marked unavailable

no secrets are exposed

monitoring overhead remains bounded

no fake infrastructure values exist

52. Final Engine Definition

Storage Engine = Host Resource Monitoring + Runtime Health + Engine Health + Storage Health + Network Health + Infrastructure State + Historical Monitoring Engine.

Final architecture:

             VM / LOCALHOST / SERVER
                       ↓
                STORAGE ENGINE
                       ↓
       ┌───────────────┼────────────────┐
       ↓               ↓                ↓
    HOST             RUNTIME          STORAGE
 CPU/RAM/Disk      Process/Worker    DB/Queue/IO
 Network/Load      PID/Threads       Latency
 Uptime            App Health       Capacity
       └───────────────┼────────────────┘
                       ↓
                NORMALIZED STATE
                       ↓
             CURRENT + HISTORY
                       ↓
        ┌──────────────┼──────────────┐
        ↓              ↓              ↓
       UI       Notification       Audit
                    Engine

Storage Engine is therefore the project's infrastructure and runtime observability authority, not a trading-business engine.

It tells the system and UI what the backend environment is doing, whether the runtime is healthy, where resources are being consumed, whether storage/persistence is healthy, and how the infrastructure state has changed over time.