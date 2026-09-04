import mongoConnector from '../config/mongoConnector.js';
import Lead from '../models/leadModel.js';
import LeadCollection from '../models/leadCollectionModel.js';
import AccountAdmin from '../models/accountAdminModel.js';
import LeadNote from '../models/leadNoteModel.js';
import LeadReminder from '../models/leadReminderModel.js';
import LeadExport from '../models/leadExportModel.js';

const models = [Lead, LeadCollection, AccountAdmin, LeadNote, LeadReminder, LeadExport];

if (process.env.CREATE_INDEXES_CONFIRM !== 'CREATE_MISSING_INDEXES') {
    throw new Error('Set CREATE_INDEXES_CONFIRM=CREATE_MISSING_INDEXES after reviewing the Atlas runbook');
}

try {
    await mongoConnector.connect();
    for (const model of models) {
        await model.createIndexes();
        console.log(`[indexes] Ensured declared indexes for ${model.collection.collectionName}`);
    }
} finally {
    await mongoConnector.disconnect();
}
