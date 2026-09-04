import mongoConnector from '../config/mongoConnector.js';
import Lead from '../models/leadModel.js';

try {
    await mongoConnector.connect();
    await Lead.createIndexes();
    console.log('Declared lead indexes created if missing. No existing index was dropped.');
} finally {
    await mongoConnector.disconnect();
}
