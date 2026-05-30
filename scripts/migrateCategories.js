/**
 * One-time migration script: converts legacy LeadCategory.fields from
 * an array of strings to an array of column-definition objects.
 *
 * Run ONCE before deploying the new version:
 *   node scripts/migrateCategories.js
 *
 * Safe to re-run — already-migrated documents are skipped.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import dns from 'dns';

dotenv.config();
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME   = process.env.MONGO_DB_NAME || 'leadapp';

async function migrate() {
    await mongoose.connect(MONGO_URI, { dbName: DB_NAME });
    console.log('[migrate] Connected to MongoDB');

    const collection = mongoose.connection.collection('lead_categories');
    const cursor = collection.find({});

    let migrated = 0;
    let skipped  = 0;

    for await (const doc of cursor) {
        const fields = doc.fields ?? [];

        // Skip if already migrated (all elements are objects, not strings)
        const alreadyMigrated = fields.length === 0 || fields.every(f => typeof f === 'object' && f !== null);
        if (alreadyMigrated) {
            skipped++;
            continue;
        }

        // Convert each string field to a column-definition object
        const converted = fields.map(f => {
            if (typeof f === 'string') {
                return {
                    label: f,                                          // use raw key as label for now
                    field: f.toLowerCase().replace(/\s+/g, '_'),       // normalize key
                    type:  'text'
                };
            }
            return f; // already an object — keep as-is
        });

        await collection.updateOne({ _id: doc._id }, { $set: { fields: converted } });
        console.log(`[migrate] ✓ Migrated category "${doc.categoryName}" (${doc._id}) — ${converted.length} field(s)`);
        migrated++;
    }

    console.log(`\n[migrate] Done. Migrated: ${migrated}, Skipped (already up-to-date): ${skipped}`);
    await mongoose.disconnect();
}

migrate().catch(err => {
    console.error('[migrate] Fatal error:', err);
    process.exit(1);
});
