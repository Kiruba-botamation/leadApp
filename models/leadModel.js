import mongoose from 'mongoose';

const leadSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: () => new mongoose.Types.ObjectId().toHexString()
    },
    acctId: {
      type: String,
      required: true
    }
  },
  {
    strict: false,
    timestamps: true
  }
);

// Cursor list shapes use the sorted value and _id as a deterministic tie-breaker.
leadSchema.index({ acctId: 1, updatedAt: -1, _id: -1 });
leadSchema.index({ acctId: 1, createdAt: -1, _id: -1 });
leadSchema.index({ acctId: 1, collectionId: 1, updatedAt: -1, _id: -1 });
leadSchema.index({ acctId: 1, collectionId: 1, createdAt: -1, _id: -1 });
leadSchema.index({ acctId: 1, responsible: 1, updatedAt: -1, _id: -1 });
leadSchema.index({ acctId: 1, collectionId: 1, responsible: 1, updatedAt: -1, _id: -1 });
leadSchema.index({ acctId: 1, collectionId: 1, stage: 1, updatedAt: -1, _id: -1 });
leadSchema.index({ acctId: 1, collectionId: 1, stage: 1, responsible: 1, updatedAt: -1, _id: -1 });

// Time-series analytics retains its stage/date shape; _id also makes cursor reuse stable.
leadSchema.index({ acctId: 1, collectionId: 1, stage: 1, createdAt: -1, _id: -1 });

const Lead = mongoose.model('Lead', leadSchema);

export default Lead;
