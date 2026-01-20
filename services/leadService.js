import Lead from '../models/leadModel.js';

class LeadService {
  /**
   * Create new lead(s)
   */
  async createLead(leadData) {
    try {
      if (Array.isArray(leadData)) {
        const leads = await Lead.insertMany(leadData);
        return leads;
      } else {
        const lead = new Lead(leadData);
        await lead.save();
        return lead;
      }
    } catch (error) {
      console.error('Error creating lead:', error);
      throw new Error(`Failed to create lead: ${error.message}`);
    }
  }

  /**
   * Get all leads with pagination and filtering
   */
  async getAllLeads(filters = {}) {
    try {
      const { page = 1, limit = 10, sortBy = 'createdAt', sortOrder = -1, status, search } = filters;

      const query = {};

      // Status filter
      if (status) {
        query.status = status;
      }

      // Search filter
      if (search) {
        query.$or = [
          { trainerName: { $regex: search, $options: 'i' } },
          { memberName: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } }
        ];
      }

      const skip = (page - 1) * limit;
      const sort = { [sortBy]: sortOrder };

      const leads = await Lead.find(query)
        .sort(sort)
        .skip(skip)
        .limit(limit);

      const total = await Lead.countDocuments(query);

      return {
        data: leads,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit)
        }
      };
    } catch (error) {
      console.error('Error getting leads:', error);
      throw new Error(`Failed to get leads: ${error.message}`);
    }
  }

  /**
   * Update lead
   */
  async updateLead(id, updateData) {
    try {
      const lead = await Lead.findByIdAndUpdate(id, updateData, { new: true });
      return lead;
    } catch (error) {
      console.error('Error updating lead:', error);
      throw new Error(`Failed to update lead: ${error.message}`);
    }
  }

  /**
   * Delete lead
   */
  async deleteLead(id) {
    try {
      await Lead.findByIdAndDelete(id);
      return true;
    } catch (error) {
      console.error('Error deleting lead:', error);
      throw new Error(`Failed to delete lead: ${error.message}`);
    }
  }
}

export default new LeadService();
