import mongoose from 'mongoose';
import dns from 'dns';
import logger from '../utils/logger.js';
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

const positiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const DEFAULT_MAX_TIME_MS = positiveInteger(process.env.MONGO_QUERY_MAX_TIME_MS, 10000);

const applyMaxTime = (query, maxTimeMS = DEFAULT_MAX_TIME_MS) => (
  maxTimeMS ? query.maxTimeMS(maxTimeMS) : query
);

class MongoConnector {
  async connect() {
    try {
      const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
      const dbName = process.env.MONGO_DB_NAME || 'leadapp';
      const telemetryEnabled = process.env.MONGO_COMMAND_TELEMETRY === 'true';
      const maxPoolSize = positiveInteger(process.env.MONGO_MAX_POOL_SIZE, 20);
      const minPoolSize = Math.min(positiveInteger(process.env.MONGO_MIN_POOL_SIZE, 1), maxPoolSize);

      await mongoose.connect(mongoUri, {
        dbName,
        autoIndex: process.env.NODE_ENV !== 'production',
        maxPoolSize,
        minPoolSize,
        serverSelectionTimeoutMS: positiveInteger(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS, 10000),
        connectTimeoutMS: positiveInteger(process.env.MONGO_CONNECT_TIMEOUT_MS, 10000),
        socketTimeoutMS: positiveInteger(process.env.MONGO_SOCKET_TIMEOUT_MS, 45000),
        monitorCommands: telemetryEnabled
      });

      if (telemetryEnabled) this.attachTelemetry();

      console.log('MongoDB connected successfully');

      return true;
    } catch (error) {
      console.error('MongoDB connection error:', error);
      throw error;
    }
  }

  attachTelemetry() {
    if (this.telemetryAttached) return;
    const client = mongoose.connection.getClient();
    const slowMs = positiveInteger(process.env.MONGO_SLOW_QUERY_MS, 500);
    client.on('commandSucceeded', event => {
      if (event.duration >= slowMs) {
        logger.warn('Slow MongoDB command', {
          command: event.commandName,
          durationMs: event.duration,
          database: event.databaseName
        });
      }
    });
    client.on('commandFailed', event => {
      logger.error('MongoDB command failed', {
        command: event.commandName,
        durationMs: event.duration,
        code: event.failure?.code
      });
    });
    this.telemetryAttached = true;
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

export async function performUpsert(Model, filter, data, options = {}) {
  if (Object.keys(filter).length === 0) {
    const doc = await Model.create(data);
    return { doc };
  }
  const doc = await applyMaxTime(
    Model.findOneAndUpdate(filter, { $set: data }, { new: true, upsert: true }),
    options.maxTimeMS
  );
  return { doc };
}

export async function performGet(Model, query, populate = [], options = {}) {
  const { sort, skip, limit, select, maxTimeMS } = options;
  let q = Model.find(query);
  if (populate && populate.length) q = q.populate(populate);
  if (select) q = q.select(select);
  if (sort) q = q.sort(sort);
  if (skip != null) q = q.skip(skip);
  if (limit != null) q = q.limit(limit);
  q = applyMaxTime(q, maxTimeMS);
  q = q.lean();
  const data = await q;
  return { success: true, data };
}

export async function performCount(Model, query, options = {}) {
  return applyMaxTime(Model.countDocuments(query), options.maxTimeMS);
}

export async function perfomDataExistanceCheck(Model, filter, options = {}) {
  return applyMaxTime(Model.findOne(filter), options.maxTimeMS).lean();
}

export async function performDelete(Model, filter, options = {}) {
  return applyMaxTime(Model.deleteOne(filter), options.maxTimeMS);
}

export async function performAggregate(Model, pipeline, options = {}) {
  return Model.aggregate(pipeline).option({ allowDiskUse: true, maxTimeMS: DEFAULT_MAX_TIME_MS, ...options });
}
