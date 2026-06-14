/**
 * account_admins Field Rename Migration
 *
 * Renames the `adminId` field to `chatbotAdminId` in every document of
 * the `account_admins` collection.
 *
 * Background:
 *   `adminId` stored the Botamation platform admin identifier.
 *   It has been renamed to `chatbotAdminId` to distinguish it from
 *   `account_admins._id`, which is now used as the adminId in
 *   lead_notes and lead_reminders.
 *
 * ── Run ───────────────────────────────────────────────────────────────────────
 *   node --env-file=.env.local scripts/migrateAccountAdminId.js
 *
 * ── Safety ────────────────────────────────────────────────────────────────────
 *  • DRY_RUN = true  → prints what would change, touches nothing in DB
 *  • DRY_RUN = false → renames the field in MongoDB
 *
 * ── Idempotency ───────────────────────────────────────────────────────────────
 *  Safe to run multiple times. Documents that already have `chatbotAdminId`
 *  (and no `adminId`) are left untouched.
 */

// Uses the same mongoConnector as the app — identical DNS overrides, URI, and dbName
import mongoConnector from '../config/mongoConnector.js';
import mongoose from 'mongoose';

// ── Configuration ─────────────────────────────────────────────────────────────
const DRY_RUN = false; // Set to false to apply changes

// ── Connect (same path as the application) ───────────────────────────────────
await mongoConnector.connect();
console.log('[Migration] Connected to MongoDB');

const db = mongoose.connection.db;
const collection = db.collection('account_admins');

// ── Count affected documents ──────────────────────────────────────────────────
const affectedCount = await collection.countDocuments({ adminId: { $exists: true } });
console.log(`[Migration] Documents with 'adminId' field: ${affectedCount}`);

if (affectedCount === 0) {
    console.log('[Migration] Nothing to migrate — all documents already use chatbotAdminId');
    await mongoConnector.disconnect();
    process.exit(0);
}

// ── Preview ───────────────────────────────────────────────────────────────────
if (DRY_RUN) {
    const samples = await collection
        .find({ adminId: { $exists: true } }, { projection: { _id: 1, acctId: 1, email: 1, adminId: 1 } })
        .limit(5)
        .toArray();

    console.log('\n[Migration] DRY RUN — sample documents that would be updated:');
    samples.forEach((doc, i) => {
        console.log(`  #${i + 1}  _id=${doc._id}  acctId=${doc.acctId}  email=${doc.email}  adminId=${doc.adminId}`);
    });
    console.log(`\n[Migration] Total documents to update: ${affectedCount}`);
    console.log('[Migration] Set DRY_RUN = false to apply the rename');
    await mongoConnector.disconnect();
    process.exit(0);
}

// ── Apply rename ──────────────────────────────────────────────────────────────
console.log('[Migration] Applying $rename: adminId → chatbotAdminId ...');
const result = await collection.updateMany(
    { adminId: { $exists: true } },
    { $rename: { adminId: 'chatbotAdminId' } }
);

console.log(`[Migration] Done. Modified: ${result.modifiedCount} / Matched: ${result.matchedCount}`);

// ── Drop old indexes (Mongoose will recreate correct ones on next app start) ──
try {
    await collection.dropIndex('acctId_1_adminId_1');
    console.log('[Migration] Dropped old index: acctId_1_adminId_1');
} catch {
    console.log('[Migration] Index acctId_1_adminId_1 not found — already removed');
}
try {
    await collection.dropIndex('adminId_1');
    console.log('[Migration] Dropped old index: adminId_1');
} catch {
    console.log('[Migration] Index adminId_1 not found — already removed');
}

await mongoConnector.disconnect();
console.log('[Migration] Disconnected. Migration complete.');
