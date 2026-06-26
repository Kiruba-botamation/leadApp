import mongoose from 'mongoose';

const leadSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: () => new mongoose.Types.ObjectId().toHexString()
    },
    acctId: {
      type: String
    }
  },
  {
    strict: false,
    timestamps: true
  }
);

// Compound index: category-scoped queries sorted by updatedAt (covers find + sort + countDocuments)
leadSchema.index({ acctId: 1, categoryId: 1, updatedAt: -1 });

// Fallback index: account-scoped queries without categoryId
leadSchema.index({ acctId: 1, updatedAt: -1 });

// Index for createdAt time-series analytics (xAxis = 'createdAt' with date filter)
leadSchema.index({ acctId: 1, createdAt: -1 });
leadSchema.index({ acctId: 1, categoryId: 1, createdAt: -1 });

// Per-admin visibility: non-superadmins only see leads assigned to them (responsible = userId)
leadSchema.index({ acctId: 1, responsible: 1, updatedAt: -1 });

// Stage filtering in the grid (equality on stage + sort by recency) — ESR order
leadSchema.index({ acctId: 1, categoryId: 1, stage: 1, updatedAt: -1 });

// Stage analytics / counts over time (e.g. "hot leads today")
leadSchema.index({ acctId: 1, categoryId: 1, stage: 1, createdAt: -1 });

const Lead = mongoose.model('Lead', leadSchema);

export default Lead;
