import mongoose from 'mongoose';
import { pathToFileURL } from 'node:url';
import { assertReadOnlyQueryPlanCases, buildQueryPlanCases } from './queryPlanCases.js';

const CONFIRMATION = 'READ_ONLY_QUERY_PLAN_AUDIT';
const MAX_TIME_MS = 10_000;

function required(env, name) {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
}

function summarizeExecution(explain) {
    const stats = explain.executionStats || {};
    const planner = explain.queryPlanner || {};
    return {
        namespace: planner.namespace,
        winningPlan: planner.winningPlan,
        execution: {
            nReturned: stats.nReturned,
            executionTimeMillis: stats.executionTimeMillis,
            totalKeysExamined: stats.totalKeysExamined,
            totalDocsExamined: stats.totalDocsExamined
        }
    };
}

export async function runQueryPlanAudit(env = process.env) {
    if (env.QUERY_PLAN_AUDIT_CONFIRM !== CONFIRMATION) {
        throw new Error(`Set QUERY_PLAN_AUDIT_CONFIRM=${CONFIRMATION} to confirm the bounded read-only audit`);
    }

    const inputs = {
        acctId: required(env, 'AUDIT_ACCT_ID'),
        leadId: required(env, 'AUDIT_LEAD_ID'),
        userId: required(env, 'AUDIT_USER_ID'),
        collectionId: env.AUDIT_COLLECTION_ID?.trim() || null
    };
    const uri = env.MONGODB_URI?.trim();
    if (!uri) throw new Error('MONGODB_URI is required');
    const dbName = env.MONGO_DB_NAME?.trim() || 'leadapp';
    const cases = assertReadOnlyQueryPlanCases(buildQueryPlanCases(inputs));

    await mongoose.connect(uri, {
        dbName,
        readPreference: 'secondaryPreferred',
        serverSelectionTimeoutMS: MAX_TIME_MS
    });

    try {
        const db = mongoose.connection.db;
        const indexStats = {};
        for (const collection of [...new Set(cases.map(item => item.collection))]) {
            indexStats[collection] = await db.collection(collection)
                .aggregate([{ $indexStats: {} }], { maxTimeMS: MAX_TIME_MS })
                .toArray();
        }

        const explains = {};
        for (const item of cases) {
            const result = await db.command({
                explain: { ...item.command, maxTimeMS: MAX_TIME_MS },
                verbosity: 'executionStats'
            });
            explains[item.name] = summarizeExecution(result);
        }

        return {
            capturedAt: new Date().toISOString(),
            database: dbName,
            readPreference: 'secondaryPreferred',
            maxTimeMS: MAX_TIME_MS,
            inputs,
            indexStats,
            explains
        };
    } finally {
        await mongoose.disconnect();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runQueryPlanAudit()
        .then(result => console.log(JSON.stringify(result, null, 2)))
        .catch(error => {
            console.error(`[query-plan-audit] ${error.message}`);
            process.exitCode = 1;
        });
}
