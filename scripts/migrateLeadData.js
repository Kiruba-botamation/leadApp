/**
 * Lead Data Field Migration Script
 *
 * Remaps field keys in lead documents for a given collection.
 * Use this when you rename or reorganise fields in a collection schema and
 * need the existing lead data to match the new field keys.
 *
 * ── Configuration ────────────────────────────────────────────────────────────
 * Edit the CONFIG section below before running:
 *
 *   COLLECTION_ID — the MongoDB _id of the target LeadCollection document
 *   FIELD_MAP    — an object mapping OLD field key → NEW field key
 *                  e.g. { "full_name": "name", "mob": "mobile_number" }
 *
 * ── Run ───────────────────────────────────────────────────────────────────────
 *   node --env-file=.env.local scripts/migrateLeadData.js
 *
 * ── Safety ────────────────────────────────────────────────────────────────────
 *  • DRY_RUN = true  → prints what would change, touches nothing in DB
 *  • DRY_RUN = false → writes changes to MongoDB
 *  • Safe to re-run   → documents already migrated are skipped
 *  • Old field key is REMOVED from the document after the value is copied
 *    to the new key (set new + unset old in a single atomic update)
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import dns from 'dns';

dotenv.config();
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

// ── ✏️  EDIT THIS SECTION ────────────────────────────────────────────────────

/** MongoDB _id of the LeadCollection you want to migrate leads for */
const COLLECTION_ID = '69db9283efec5b2d90b2c1df'; // ← replace with your collection _id

/**
 * Mapping of OLD field key → NEW field key.
 * Only fields listed here are touched; all other fields are left as-is.
 *
 * Examples:
 *   "full_name"  → "name"
 *   "mob"        → "mobile_number"
 *   "src"        → "lead_source"
 */
const FIELD_MAP = {
    // 'old_field': 'new_field',
    'User ID': 'id',
    'Name': 'name',
    'Attendance': 'attendance',
    'Company': 'company',
    'Designation': 'designation',
    'Lead Source': 'lead_source',
    'Registration': 'registration',
    'Phone': 'phone'
};
// };

/**
 * Set to false to apply changes.
 * Leave as true to do a dry run (safe preview, no DB writes).
 */
const DRY_RUN = false;

// ── End of config ─────────────────────────────────────────────────────────────

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGO_DB_NAME || 'leadapp';

async function migrate() {
    if (!COLLECTION_ID || COLLECTION_ID === '64abc123def456789012345a') {
        console.error('[migrate] ✗ COLLECTION_ID is not set. Edit the CONFIG section in this script.');
        process.exit(1);
    }

    if (Object.keys(FIELD_MAP).length === 0) {
        console.error('[migrate] ✗ FIELD_MAP is empty. Nothing to do. Edit the CONFIG section.');
        process.exit(1);
    }

    await mongoose.connect(MONGO_URI, { dbName: DB_NAME });
    console.log(`[migrate] Connected to MongoDB (db: ${DB_NAME})`);
    console.log(`[migrate] Collection ID : ${COLLECTION_ID}`);
    console.log(`[migrate] Field map   : ${JSON.stringify(FIELD_MAP, null, 2)}`);
    console.log(`[migrate] Dry run     : ${DRY_RUN ? 'YES — no changes will be written' : 'NO  — changes WILL be written'}`);
    console.log('');

    const collection = mongoose.connection.collection('leads');

    // collectionId is stored as a plain string in lead documents (not a BSON ObjectId)
    const cursor = collection.find({ collectionId: COLLECTION_ID });

    let migrated = 0;
    let skipped = 0;
    let total = 0;

    for await (const doc of cursor) {
        total++;

        // Build the $set and $unset payloads
        const $set = {};
        const $unset = {};

        for (const [oldKey, newKey] of Object.entries(FIELD_MAP)) {
            if (oldKey === newKey) continue; // nothing to do

            const hasOld = Object.prototype.hasOwnProperty.call(doc, oldKey);
            const hasNew = Object.prototype.hasOwnProperty.call(doc, newKey);

            if (!hasOld) {
                // Old field doesn't exist — might already be migrated
                if (hasNew) {
                    // New key already present — skip this mapping for this doc
                    continue;
                }
                // Neither exists — skip
                continue;
            }

            // Old field exists — migrate it
            $set[newKey] = doc[oldKey];
            $unset[oldKey] = '';
        }

        if (Object.keys($set).length === 0) {
            skipped++;
            continue;
        }

        const updateOp = {};
        if (Object.keys($set).length) updateOp.$set = $set;
        if (Object.keys($unset).length) updateOp.$unset = $unset;

        if (DRY_RUN) {
            console.log(`[dry-run] Would update lead ${doc._id}:`);
            console.log(`          $set   = ${JSON.stringify($set)}`);
            console.log(`          $unset = ${JSON.stringify($unset)}`);
        } else {
            await collection.updateOne({ _id: doc._id }, updateOp);
            console.log(`[migrate] ✓ Updated lead ${doc._id}`);
        }

        migrated++;
    }

    console.log('');
    console.log(`[migrate] Done.`);
    console.log(`  Total leads found : ${total}`);
    console.log(`  ${DRY_RUN ? 'Would migrate' : 'Migrated'}   : ${migrated}`);
    console.log(`  Skipped (already up-to-date or field absent) : ${skipped}`);

    if (DRY_RUN && migrated > 0) {
        console.log('');
        console.log('[migrate] ⚠️  This was a DRY RUN. Set DRY_RUN = false to apply changes.');
    }

    await mongoose.disconnect();
}

migrate().catch(err => {
    console.error('[migrate] Fatal error:', err);
    process.exit(1);
});
