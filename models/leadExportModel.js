import mongoose from 'mongoose';

const leadExportSchema = new mongoose.Schema({
    _id: { type: String, default: () => new mongoose.Types.ObjectId().toHexString() },
    acctId: { type: String, required: true },
    userId: { type: String, required: true },
    status: {
        type: String,
        enum: ['queued', 'running', 'completed', 'failed', 'cancelled', 'expired'],
        default: 'queued',
        required: true
    },
    active: { type: Boolean, default: true, required: true },
    slot: { type: Number, required: true },
    input: { type: mongoose.Schema.Types.Mixed, required: true },
    processedRows: { type: Number, default: 0 },
    totalRows: { type: Number, default: null },
    progress: { type: Number, default: 0 },
    cancelRequested: { type: Boolean, default: false },
    fileName: String,
    contentType: { type: String, default: 'text/csv; charset=utf-8' },
    sizeBytes: Number,
    storage: {
        provider: { type: String, enum: ['local', 's3'] },
        key: String
    },
    error: String,
    startedAt: Date,
    completedAt: Date,
    expiresAt: Date
}, { timestamps: true });

leadExportSchema.index({ acctId: 1, userId: 1, createdAt: -1 });
leadExportSchema.index(
    { acctId: 1, slot: 1 },
    { unique: true, partialFilterExpression: { active: true } }
);
leadExportSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

export default mongoose.model('LeadExport', leadExportSchema);
