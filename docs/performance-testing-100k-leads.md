# Performance Testing at 100k Leads per Account

## Target and SLOs

Test with at least one 100k-lead tenant, multiple smaller tenants, and one concurrent noisy tenant. Preserve realistic collection, stage, responsible-user, null, date, and dynamic-field distributions. A uniform fixture is only a plumbing baseline.

Initial server-side SLOs, measured at the API boundary under the agreed peak concurrency:

| Operation | p95 | p99 | Error/timeout rate |
|---|---:|---:|---:|
| Lead first page, 50 rows | <= 300 ms | <= 750 ms | < 0.5% |
| Lead keyset next page | <= 350 ms | <= 800 ms | < 0.5% |
| Lead by ID | <= 100 ms | <= 250 ms | < 0.1% |
| Notes/reminders first page | <= 200 ms | <= 500 ms | < 0.5% |
| Admin membership check | <= 75 ms | <= 150 ms | < 0.1% |
| Reminder bell | <= 200 ms | <= 500 ms | < 0.5% |

Also require no sustained pool wait, CPU below 70% steady state, no growing replication/queue lag, no unbounded `COLLSCAN`, no blocking sort for indexed list shapes, and `docsExamined / returned` close to 1 for selective lists. Agree separate cold-cache and warm-cache results. Client/network rendering is outside these server-side SLOs.

## Safe local fixture generation

The generator creates deterministic newline-delimited JSON locally and never contacts MongoDB. It refuses to overwrite an existing file. It is not an importer and does not alter any database.

Explicit operator command in PowerShell:

```powershell
$env:PERFORMANCE_FIXTURE_CONFIRM='GENERATE_LOCAL_LEAD_FIXTURE'
npm run perf:generate-fixture -- --acct-id perf-account-1 --count 100000 --output .\perf-account-1.ndjson
```

The generated addresses use the reserved `.invalid` domain. IDs and dates are deterministic so runs can be compared. Generate separate files with different `--acct-id` values for multi-tenant tests. Store large fixtures outside Git and remove them according to the test-data retention policy.

## Import and environment safety

Use an isolated Atlas project or disposable staging database with production-equivalent MongoDB version, topology, indexes, tier, and network path. Never load synthetic records into production.

Choose and review an import mechanism separately. One possible operator-run command is:

```powershell
mongoimport --uri '<staging-uri>' --db '<staging-database>' --collection leads --file .\perf-account-1.ndjson
```

`mongoimport` writes data and is intentionally not wrapped by an npm script. Verify the target from the prompt and Atlas UI, use least-privilege staging credentials, import a small sample first, and delete the disposable database after evidence is retained.

After import, build the same indexes as production using the reviewed migration procedure. Do not use production `syncIndexes()` casually. Record collection/index sizes and wait for replica lag and cache pressure to stabilize.

## Workload design

- Warm-up for 5-10 minutes, measure for at least 20 minutes, and cool down before changing one variable.
- Use open-loop arrival rates when validating latency under load; closed-loop-only tests can hide overload through coordinated omission.
- Model first-page and keyset pagination separately. Avoid deep `skip` pagination.
- Mix lead lists (with/without collection and responsible), lead-by-ID, note/reminder lists, membership checks, and bell reads in production-observed proportions.
- Include concurrent reminder workers and representative writes in staging, but keep the query-plan audit itself read-only.
- Test warm cache, cold/restarted cache, peak traffic, one noisy tenant, primary election, and pool exhaustion/backpressure.
- Use synthetic users and tenants. Do not copy production PII into fixtures or result artifacts.

Suggested gates are 1x expected peak for 30 minutes with SLO compliance, 1.5x peak for 15 minutes without unstable queues/lag, and a controlled step test to identify the knee. Stop before cluster health or recovery objectives are threatened.

## Evidence and diagnosis

Before and after each run, execute the guarded audit documented in `docs/atlas-production-scaling-runbook.md`. Correlate its `$indexStats` and `executionStats` with Atlas metrics, Query Profiler, application latency, event-loop lag, pool checkout time, and BullMQ lag.

Capture test revision, fixture recipe/counts, Atlas tier/topology, index inventory, autoscaling events, app/worker instance counts, pool settings, concurrency, request mix, warm-up duration, percentile histograms, errors, and query-plan artifacts. Redact URIs, tokens, user data, and host details before sharing.

A run passes only when SLOs hold throughout steady state and queues, connections, cache, disk latency, and replication lag return to baseline after load. Average latency alone is not acceptance evidence.
