# Atlas Production Scaling Runbook

This is an operator-run runbook. No command below is run by the application, deployment pipeline, or performance scripts. Replace every `<placeholder>`, capture output in the change ticket, and test against a production-sized staging snapshot first.

## Gates and ownership

- Name an incident commander, database operator, application owner, and rollback decision maker.
- Confirm the Atlas project/cluster, maintenance window, current primary region, MongoDB version, and support plan.
- Record baseline p50/p95/p99 latency, error rate, connections, CPU, memory, disk IOPS/latency, replication lag, queue lag, and working-set/cache metrics.
- Stop if tenant isolation is not enforced server-side. A shard key is routing, not authorization.
- Stop if backups are unhealthy, a restore rehearsal has not passed, or rollback thresholds are not agreed.

## Tenant shard-key prerequisites

Candidate collections are `leads`, `lead_notes`, and tenant-scoped `lead_reminders`. Do not assume all collections should share one key.

Before sharding, prove all of the following:

- Every document has a canonical, immutable, non-null string `acctId`; produce missing/type/cardinality and per-tenant size distributions.
- Every latency-sensitive query includes equality on `acctId`, including `$lookup` pipelines, background work, exports, and administrative reads.
- All unique indexes are shard-key compatible. On a sharded collection, unique indexes generally require the shard key as a prefix. Existing global uniqueness can conflict with tenant sharding.
- The selected key has enough cardinality/chunks, avoids monotonically increasing hot ranges, and does not create jumbo chunks.
- The cluster tier supports sharding and has capacity for index builds, balancing, resharding, and replication.

`account_admins` uses tenant-local uniqueness with `acctId` as the leading key. Verify the tenant-scoped index migration has completed before considering it for sharding; a small lookup/reference collection may still remain unsharded.

Shard-key tradeoffs:

| Candidate | Benefit | Cost |
|---|---|---|
| `{ acctId: 1 }` | Tenant equality targets one shard; supports zone placement | A large/noisy tenant cannot split across shards; tenant-size skew can create hotspots |
| `{ acctId: "hashed" }` | Spreads different tenants more evenly | All rows for one tenant share one hashed value; no range locality or useful zone ranges |
| `{ acctId: 1, _id: "hashed" }` | Can distribute a single large tenant | Tenant-only list queries scatter across that tenant's chunks; pagination/merges cost more |
| A workload-derived compound range key | Can target dominant collection/stage access | Other tenant queries may scatter; higher operational and index complexity |

For the stated 100k leads/account target, begin by validating an unsharded, right-sized replica set with tenant-first indexes. Sharding is justified by measured working-set, throughput, storage, or noisy-neighbor limits, not row count alone.

Operator-run prerequisite probes in `mongosh`:

```javascript
use("<database>")
db.leads.aggregate([
  { $group: { _id: { type: { $type: "$acctId" }, value: "$acctId" }, count: { $sum: 1 } } },
  { $sort: { count: -1 } },
  { $limit: 100 }
], { allowDiskUse: false, maxTimeMS: 30000 })
db.leads.countDocuments({ $or: [{ acctId: { $exists: false } }, { acctId: null }, { acctId: { $not: { $type: "string" } } }] })
db.leads.getIndexes()
db.leads.getShardDistribution()
```

Example sharding commands, only after review and staging rehearsal:

```javascript
sh.enableSharding("<database>")
db.leads.createIndex({ acctId: 1 })
sh.shardCollection("<database>.leads", { acctId: 1 })
```

Do not run `reshardCollection` as an exploratory action. It is a capacity-intensive production change with version-specific behavior; create a separate reviewed plan using the Atlas-supported procedure.

## Query and index evidence

Capture `$indexStats` and bounded `executionStats` before and after each change. The repository audit uses `secondaryPreferred`, a 10-second selection/query bound, limits of at most 101, and only `find`/`explain` plus `$indexStats`. Secondary plans and cache state can differ from the primary, so corroborate findings with Atlas Query Profiler and primary metrics.

PowerShell, explicitly run by an operator:

```powershell
$env:MONGODB_URI='<atlas-uri>'
$env:MONGO_DB_NAME='<database>'
$env:AUDIT_ACCT_ID='<representative-account-id>'
$env:AUDIT_LEAD_ID='<lead-id-in-that-account>'
$env:AUDIT_USER_ID='<user-id-in-that-account>'
$env:AUDIT_COLLECTION_ID='<collection-id-in-that-account>'
$env:QUERY_PLAN_AUDIT_CONFIRM='READ_ONLY_QUERY_PLAN_AUDIT'
npm run perf:audit-plans > .\query-plan-before.json
```

Review each plan for `COLLSCAN`, blocking `SORT`, rejected plans, shard fan-out, `totalDocsExamined / nReturned`, `totalKeysExamined / nReturned`, and timeout. An empty representative tenant is not valid evidence. `$indexStats` resets on process restart and only shows use since restart.

## Rolling index migration

1. Inventory indexes, sizes, constraints, query plans, and Atlas Performance Advisor recommendations.
2. Check free disk/IOPS and replication lag headroom. Schedule one index change at a time.
3. Create the replacement under a new descriptive name. Modern MongoDB index builds replicate and are resumable, but still consume CPU, I/O, memory, and disk.
4. Wait for all members, then capture explain evidence. Do not infer usefulness from build success.
5. Keep the old index through at least one full traffic cycle. Hide it first, observe, then drop only in a later change.

Operator-run example:

```javascript
use("<database>")
db.leads.getIndexes()
db.leads.createIndex(
  { acctId: 1, collectionId: 1, updatedAt: -1, _id: -1 },
  { name: "acct_collection_updated_id_v2" }
)
db.runCommand({ collMod: "leads", index: { name: "<old-index-name>", hidden: true } })
// After the observation window and separate approval only:
db.leads.dropIndex("<old-index-name>")
```

Do not use `syncIndexes()` as a production rolling migration: it can drop indexes to match model declarations. Do not drop `_id_`. Hidden indexes still consume disk and write maintenance but are ignored by the planner.

After staging review, the application can create only missing declared indexes (it never drops indexes):

```powershell
$env:CREATE_INDEXES_CONFIRM='CREATE_MISSING_INDEXES'
npm run migrate:create-indexes
```


## Atlas Search boundary

Do not introduce Atlas Search for current bounded list/filter queries. Introduce it only if product adds global search across dynamic lead text fields and regex scans cannot meet the SLO.

If global search is approved, design a tenant-aware Search index and make `acctId` an exact-match filter inside the `$search` stage. Test index freshness, eventual consistency, result authorization, dynamic-field mapping growth, analyzer behavior, Search node sizing, and fallback behavior. Atlas Search is not a replacement for tenant-first database indexes, and `$search` must be the first aggregation stage.

## Autoscaling, pools, and concurrency

- Enable storage autoscaling. Enable compute autoscaling only with reviewed min/max tiers and cost alerts; set the minimum to sustain normal peak load without a scale event.
- Treat autoscaling as safety margin, not instant burst control. Scale-up takes time and scale-down can obscure capacity regressions.
- Set application connection-pool budgets from `Atlas connection limit - operational reserve`, divided across the maximum number of app and worker instances. Include rolling-deploy overlap.
- Reserve connections for migrations, monitoring, support, and failover. Alert before 70-80% of the usable budget.
- Bound HTTP concurrency, exports, analytics, reminder workers, and BullMQ consumers separately. Use queue backpressure; do not let every process independently saturate MongoDB.
- Set server-selection and query timeouts, retry only idempotent operations, and use jittered bounded retries. Monitor retry amplification.
- Validate behavior during primary election, node replacement, and regional latency; pools will reconnect and can create a thundering herd.

## Backups and restore

Before the window, verify continuous cloud backup, retention, point-in-time restore coverage, encryption/access, and the last successful snapshot. Restore into an isolated project/cluster and verify document counts, tenant sampling, indexes, application smoke tests, and measured RTO/RPO. A snapshot that has not been restored is not a proven backup.

Operator-run Atlas CLI inspection templates:

```powershell
atlas clusters describe '<cluster-name>' --projectId '<project-id>'
atlas backups snapshots list '<cluster-name>' --projectId '<project-id>'
atlas alerts list --projectId '<project-id>'
```

Atlas CLI syntax and available backup commands vary by CLI/cluster generation. Confirm with `atlas <command> --help` and the current Atlas documentation before use. Never place credentials or connection strings in tickets or captured plan files.

## Rollback and stop conditions

Stop or roll back when p95 exceeds the agreed SLO for 10 minutes, error/timeout rate breaches budget, replication lag grows continuously, cache eviction or disk latency saturates, connections exceed budget, or query plans regress to scans/blocking sorts.

- New index regression: unhide the old index; hide the new index; capture plans and metrics. Drop neither during the incident.
- Application concurrency regression: restore the prior deployment and worker concurrency; preserve query evidence.
- Compute scaling regression: restore the prior Atlas tier/minimum after confirming storage compatibility and provider limits.
- Sharding/resharding issue: stop rollout and engage Atlas support. Do not improvise metadata edits, chunk deletions, or force-balancer operations.
- Data issue: stop writers, preserve the failure timestamp, and follow the rehearsed point-in-time restore procedure into a new cluster. Validate before cutover.

Record final metrics, explain artifacts, index inventory, Atlas events, commands executed, and the rollback decision in the change ticket.
