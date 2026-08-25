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

// Compound index: collection-scoped queries sorted by updatedAt (covers find + sort + countDocuments)
leadSchema.index({ acctId: 1, collectionId: 1, updatedAt: -1 });

// Fallback index: account-scoped queries without collectionId
leadSchema.index({ acctId: 1, updatedAt: -1 });

// Index for createdAt time-series analytics (xAxis = 'createdAt' with date filter)
leadSchema.index({ acctId: 1, createdAt: -1 });
leadSchema.index({ acctId: 1, collectionId: 1, createdAt: -1 });

// Cover the high-traffic KPI query: date-range match followed by responsible grouping.
// Both account-wide and collection-scoped variants avoid fetching each matched lead.
leadSchema.index({ acctId: 1, updatedAt: -1, responsible: 1 });
leadSchema.index({ acctId: 1, createdAt: -1, responsible: 1 });
leadSchema.index({ acctId: 1, collectionId: 1, updatedAt: -1, responsible: 1 });
leadSchema.index({ acctId: 1, collectionId: 1, createdAt: -1, responsible: 1 });

// Per-admin visibility: non-superadmins only see leads assigned to them (responsible = userId)
leadSchema.index({ acctId: 1, responsible: 1, updatedAt: -1 });

// Stage filtering in the grid (equality on stage + sort by recency) — ESR order
leadSchema.index({ acctId: 1, collectionId: 1, stage: 1, updatedAt: -1 });

// Stage analytics / counts over time (e.g. "hot leads today")
leadSchema.index({ acctId: 1, collectionId: 1, stage: 1, createdAt: -1 });

// Per-admin kanban: collection + responsible scoped queries (non-superadmin kanban view)
leadSchema.index({ acctId: 1, collectionId: 1, responsible: 1, updatedAt: -1 });

// Kanban with both stage AND responsible filters (ESR pattern)
leadSchema.index({ acctId: 1, collectionId: 1, stage: 1, responsible: 1, updatedAt: -1 });

const Lead = mongoose.model('Lead', leadSchema);

export default Lead;
