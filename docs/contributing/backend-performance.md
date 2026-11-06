# Backend performance

Use measurements to choose between reducing repeated work, changing process
allocation, and moving a computation to a native implementation. The tools below
do not change the normal server's default logging or enable external telemetry.

## Per-process resource measurements

From `packages/backend`, preload the optional sampler when starting a backend:

```sh
NODE_OPTIONS="--import=$(pwd)/scripts/performance-preload.mjs" \
  NODE_ENV=production node built/entry.js 2> /tmp/backend-performance.ndjson
```

Preserve any existing `NODE_OPTIONS` when adding the import. Cluster children
inherit the preload. Each process writes a `type: "performance"` JSON record to
stderr every five seconds. Other diagnostics can also use stderr.

Records identify the PID and role (`server`, `queue`, `server+queue`, or
`supervisor`) and contain:

- CPU usage, where 100% represents one fully occupied CPU core;
- RSS, V8 heap, external allocations, and ArrayBuffer memory in bytes;
- event-loop utilization, p95 delay, and maximum delay;
- GC count and total GC time during the interval.

Set `MK_PERFORMANCE_INTERVAL_MS` to change the sampling interval. No HTTP request,
account, token, database query, or message content is collected. The sampler's
timer does not keep the process alive.

## Repeatable local workloads

Run the following from `packages/backend` using a Node version supported by that
package's `engines`. The runner builds the selected production source with the
repository's installed Rolldown and dependencies, warms the workload once, then
records each measured sample. Temporary bundles are removed after the run.

### Streaming dispatch

```sh
node scripts/benchmark-backend.mjs --scenario streaming \
  --size 1000 --iterations 10000 --samples 7 \
  --source-ref HEAD --output /tmp/backend-stream-before.json

node scripts/benchmark-backend.mjs --scenario streaming \
  --size 1000 --iterations 10000 --samples 7 \
  --output /tmp/backend-stream-after.json
```

`--source-ref` reads production source from a Git revision without changing the
checkout. Use the same base revision, dependencies, Node runtime, and parameters
for a comparison. Omitting it measures the working tree. Keep benchmark runs
sequential and compare their distributions, not only the fastest sample.

This workload opens real loopback WebSocket connections through
`StreamingApiServerService`. Authentication and Redis input are controlled
substitutes. It checks targeted, unsubscribed, and broadcast delivery counts.
The measured callback counts isolate dispatch cost; they do not measure network
delivery, authentication, or client rendering performance.

### Timeline candidates

```sh
node scripts/benchmark-backend.mjs --scenario timeline \
  --size 10000 --iterations 300 --samples 7 \
  --output /tmp/backend-timeline.json
```

This scenario needs the local Redis from `.config/test.yml`. It writes only keys
under its own process-specific prefix and removes them afterward. It exercises
real Redis reads and `FanoutTimelineEndpointService.getMiNotes()` with
out-of-order IDs. Database hydration uses fixed in-memory notes, so this measures
the candidate path rather than a complete timeline API response.

### Application roles and HTTP requests

```sh
node scripts/benchmark-backend.mjs --scenario application --role server \
  --size 30 --iterations 200 --samples 3 --allow-test-database-reset \
  --output /tmp/backend-server.json

node scripts/benchmark-backend.mjs --scenario application --role queue \
  --allow-test-database-reset --output /tmp/backend-queue.json

node scripts/benchmark-backend.mjs --scenario application --role split \
  --size 30 --iterations 200 --samples 3 --allow-test-database-reset \
  --source-ref HEAD --output /tmp/backend-split.json

node scripts/benchmark-backend.mjs --scenario application --role combined \
  --size 30 --iterations 200 --samples 3 --allow-test-database-reset \
  --output /tmp/backend-combined.json
```

The application scenario **resets the local `test-misskey` database** using the
backend's test-mode schema initialization. It requires explicit opt-in and
loopback PostgreSQL/Redis. Use dedicated test services, with no other test run or
backend using their database, Redis, and HTTP port concurrently. It never starts
or stops those services for you.

Roles have the following meanings:

| Role | Application contexts |
| --- | --- |
| `server` | HTTP/WebSocket only |
| `queue` | Queue consumers only |
| `split` | HTTP and queue in two contexts in one process, for comparison |
| `combined` | HTTP and queue sharing one context |

For roles with a server, the fixture creates one local user and `--size` public
notes. It measures local timeline reads at concurrency 10, checks the returned
page size, and records p95/p99 request latency across measured samples. Queue
counts, PostgreSQL connection states, and sampled TypeORM pool peaks accompany
the process measurements. Redis client counts exclude the diagnostic client;
PostgreSQL counts exclude the diagnostic connection. TypeORM pool statistics do
not include the separate Mastodon compatibility storage pool.

These fixtures do not establish production capacity or federation throughput.
In particular, the local fixture has no remote followers and its federation
queues are empty. A shared pool should also be evaluated with representative
queue traffic before choosing deployment limits.

Add `--cpu-profile /tmp/backend-profiles` to retain a Node CPU profile. Profiles
include startup and warmup; identify the measured workload region before
attributing samples to request processing.

## Measured changes, 2026-11-06

The comparison used Node 24.22.1, the same installed dependencies and fixtures,
and base source `9b8e742302e83ff37fc33282dbf471d9211bcd20`.

Streaming results are medians of seven measured batches, each containing 10,000
messages and 1,000 connected subscribers:

| Dispatch workload | Before | After | Decision |
| --- | ---: | ---: | --- |
| One matching subscriber | 168.675 ms | 4.597 ms | Keep channel-indexed dispatch |
| No matching subscriber | 163.460 ms | 4.659 ms | Keep channel-indexed dispatch |
| Broadcast to every subscriber | 253.309 ms | 208.280 ms | No broadcast regression observed |

In the targeted scenario, median pre-sample V8 heap including the harness was
70.594 MiB before and 70.837 MiB after. The routing index adds connection-related
state; subscription cleanup is covered by the regression tests.

Single-process resource results use three fresh processes per variant. Each
HTTP run used 30 notes, concurrency 10, one warmup batch, and three measured
batches of 200 reads:

| Resource | Two contexts | Shared context |
| --- | ---: | ---: |
| Startup median | 886.612 ms | 622.922 ms |
| Idle RSS median after explicit GC | 400.813 MiB | 387.031 MiB |
| Idle V8 heap used median | 105.442 MiB | 102.012 MiB |
| Redis clients | 50 | 35 |
| Idle PostgreSQL connections | 3 | 2 |
| Observed TypeORM pool peak total | 11 | 10 |
| HTTP p95 range across fresh processes | 20.068–20.485 ms | 18.306–21.144 ms |
| HTTP p99 range across fresh processes | 21.349–21.612 ms | 21.525–22.443 ms |

The shared context removes duplicate pools and service instances. The small
HTTP fixture did not establish a latency improvement. Deterministic regression
tests check interested-subscriber routing, listener cleanup, one shared provider
instance, and draining both consumers before closing their shared dependencies.

One experiment was discarded: removing each Redis list's intermediate sort
before the final merge. On the actual candidate path, seven batches of 300
reads of 10,000 IDs measured 618.172 ms before and 623.351 ms after. There was no
repeatable gain, so the implementation was restored. Ordering/cursor tests and
the workload remain available for future pagination changes.

An additional local timeline CPU profile showed PostgreSQL row parsing and
TypeORM result-to-entity transformation among its visible hotspots. That profile
includes startup and warmup and does not exercise representative federation
normalization. Query projection and entity assembly are therefore useful next
measurement targets; this is not evidence for a JSON-LD Rust rewrite.

Validation for this change:

- Backend source, unit-test, and federation-test typechecks passed.
- Backend unit and e2e bundles built successfully; 24 focused unit tests passed.
- Timeline and streaming e2e coverage passed in aggregate: 432 tests in the broad
  run, then the remaining event test after correcting its existing `i/update`
  status expectation to the endpoint's 200 response and checking `isBot`.
  The 200 response was also independently reproduced with the base source.
- Real entry-point smoke runs for combined and default clustered modes returned
  healthy responses, emitted the expected per-process roles, and exited with
  code 0 on SIGTERM.
- Changed-file lint, SPDX, and locale safety checks passed.
- The optional broad unit run was not fully green: 1,171 tests passed, two audio
  detection tests failed with ffprobe absent, and Meilisearch setup failed with
  its test service absent; 59 tests were skipped. The e2e harness also reported
  its 10-second Vite-server teardown warning, including on the successful
  focused rerun. These results are kept separate from the entry-point smoke
  checks and passing targeted coverage.

## Choosing subsequent work

For balanced deployments, use per-role measurements to decide process and pool
budgets. The default clustered deployment still has one Web process plus queue
workers; increase Web capacity through separate `MK_ONLY_SERVER` instances when
the Web role is the measured bottleneck. Single-process mode now shares its
HTTP and queue context; clustered roles retain their separate processes.

Timeline lists can contain out-of-order arrivals. Restricting reads to the first
N list positions is not an equivalent pagination optimization. High-fanout
batching, cache capacity limits, or a different timeline index should be measured
against their own memory, Redis, and correctness requirements before adoption.

A Rust prototype should target a computation that occupies a material share of
a representative CPU profile. Existing `slacc` already performs outgoing RSA
signing on a native thread pool. The local results here support reducing repeated
dispatch work and shared-resource duplication; they do not justify a full
backend rewrite or establish a federation normalization bottleneck.
