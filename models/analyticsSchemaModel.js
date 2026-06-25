import mongoose from 'mongoose';

const analyticsSchemaModel = new mongoose.Schema(
    {
        _id: {
            type: String,
            default: () => new mongoose.Types.ObjectId().toHexString()
        },
        userId: {
            type: String,
            required: true
        },
        acctId: {
            type: String,
            required: true
        },
        schema: {
            type: mongoose.Schema.Types.Mixed,
            default: {}
        }
    },
    { timestamps: true, collection: 'analytics' }
);

// One saved dashboard per user per account — also serves the view-as lookup by userId
analyticsSchemaModel.index({ userId: 1, acctId: 1 }, { unique: true });

const AnalyticsSchema = mongoose.model('AnalyticsSchema', analyticsSchemaModel);

export default AnalyticsSchema;
