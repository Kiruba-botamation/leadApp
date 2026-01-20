import mongoose from 'mongoose';

class MongoConnector {
  async connect() {
    try {
      const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/leadapp';
      
      await mongoose.connect(mongoUri, {
        useNewUrlParser: true,
        useUnifiedTopology: true
      });

      console.log('MongoDB connected successfully');
      return true;
    } catch (error) {
      console.error('MongoDB connection error:', error);
      throw error;
    }
  }

  async disconnect() {
    try {
      await mongoose.disconnect();
      console.log('MongoDB disconnected');
      return true;
    } catch (error) {
      console.error('MongoDB disconnection error:', error);
      throw error;
    }
  }
}

export default new MongoConnector();
