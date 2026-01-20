import mongoose from 'mongoose';

const leadSchema = new mongoose.Schema(
  {
    trainerName: {
      type: String,
      required: true
    },
    memberName: {
      type: String,
      required: true
    },
    email: {
      type: String,
      required: true,
      unique: true
    },
    phone: {
      type: String
    },
    status: {
      type: String,
      enum: ['new', 'contacted', 'qualified', 'converted', 'lost'],
      default: 'new'
    },
    source: {
      type: String
    },
    notes: {
      type: String
    }
  },
  {
    timestamps: true
  }
);

const Lead = mongoose.model('Lead', leadSchema);

export default Lead;
