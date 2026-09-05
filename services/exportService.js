import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import Lead from '../models/leadModel.js';
import LeadCollection from '../models/leadCollectionModel.js';
import LeadExport from '../models/leadExportModel.js';
import { SYSTEM_FIELDS, STAGE_FIELD } from './collectionService.js';
import { assertSafeFieldKey, buildKeysetCondition, parseFieldFilters } from '../utils/leadQueryUtils.js';

const PAGE_SIZE = 100;
const MAX_FIELDS = 100;
const MAX_ACTIVE_DEFAULT = 2;
const MAX_TIME_MS = Number.parseInt(process.env.EXPORT_QUERY_MAX_TIME_MS || '30000', 10);
const FORMULA_PREFIX = /^[\t\r ]*[=+\-@]/;

const requestError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const positiveInt = (value, fallback) => {
    const parsed = Number.parseInt(value ?? fallback, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export function serializeCsvCell(value) {
    let text;
    if (value === null || value === undefined) text = '';
    else if (value instanceof Date) text = value.toISOString();
    else if (typeof value === 'object') text = JSON.stringify(value);
    else text = String(value);
    if (FORMULA_PREFIX.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function serializeCsvRow(values) {
    return `${values.map(serializeCsvCell).join(',')}\r\n`;
}

export function validateExportInput(raw) {
    if (!raw || Array.isArray(raw) || typeof raw !== 'object') throw requestError('Export input must be an object');
    const allowed = new Set(['collectionId', 'fields', 'fieldFilters', 'sortBy', 'sortOrder', 'responsibleFilter']);
    if (Object.keys(raw).some(key => !allowed.has(key))) throw requestError('Export input contains unsupported properties');
    if (typeof raw.collectionId !== 'string' || !raw.collectionId.trim()) throw requestError('collectionId is required');
    if (!Array.isArray(raw.fields) || raw.fields.length === 0 || raw.fields.length > MAX_FIELDS) {
        throw requestError(`fields must contain between 1 and ${MAX_FIELDS} columns`);
    }
    const fields = raw.fields.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw requestError('Each export field must be an object');
        const { field, label } = item;
        if (typeof field !== 'string' || !field || field.length > 128) throw requestError('Invalid export field');
        if (typeof label !== 'string' || !label.trim() || label.length > 200) throw requestError(`Invalid label for field "${field}"`);
        return { field, label: label.trim() };
    });
    if (new Set(fields.map(item => item.field)).size !== fields.length) throw requestError('Export fields must be unique');
    if (raw.fieldFilters !== undefined && (typeof raw.fieldFilters !== 'string' || raw.fieldFilters.length > 20000)) {
        throw requestError('fieldFilters must be a JSON string of at most 20000 characters');
    }
    const sortOrder = raw.sortOrder === 'asc' || raw.sortOrder === 1 ? 1
        : raw.sortOrder === 'desc' || raw.sortOrder === -1 || raw.sortOrder === undefined ? -1 : null;
    if (sortOrder === null) throw requestError('sortOrder must be asc or desc');
    if (raw.responsibleFilter !== undefined && (typeof raw.responsibleFilter !== 'string' || raw.responsibleFilter.length > 256)) {
        throw requestError('responsibleFilter must be a string');
    }
    return {
        collectionId: raw.collectionId.trim(), fields,
        fieldFilters: raw.fieldFilters || '', sortBy: raw.sortBy || 'updatedAt', sortOrder,
        responsibleFilter: raw.responsibleFilter || ''
    };
}

async function prepareInput(raw, scope) {
    const input = validateExportInput(raw);
    const collection = await LeadCollection.findOne(
        { _id: input.collectionId, acctId: scope.acctId },
        { fields: 1 }
    ).lean();
    if (!collection) throw requestError('Collection not found', 404);
    const definitions = [...SYSTEM_FIELDS, { ...STAGE_FIELD, type: 'text' }, ...(collection.fields || []),
        { field: 'createdAt', label: 'Created At', type: 'date' },
        { field: 'updatedAt', label: 'Updated At', type: 'date' }];
    const definitionByField = new Map(definitions.map(item => [item.field, item]));
    const allowed = new Set(definitionByField.keys());
    for (const item of input.fields) assertSafeFieldKey(item.field, allowed, 'export field');
    assertSafeFieldKey(input.sortBy, allowed, 'sort');
    const fieldTypes = new Map(definitions.map(item => [item.field, item.type]));
    const typedFilters = parseFieldFilters(input.fieldFilters, allowed, fieldTypes);
    const conditions = [{ acctId: scope.acctId }, { collectionId: input.collectionId }];
    if (scope.accessLevel !== 'superadmin') conditions.push({ responsible: scope.userId });
    else if (input.responsibleFilter) {
        conditions.push(input.responsibleFilter === '__unassigned__'
            ? { $or: [{ responsible: { $exists: false } }, { responsible: null }, { responsible: '' }] }
            : { responsible: input.responsibleFilter });
    }
    for (const [key, value] of Object.entries(typedFilters)) conditions.push({ [key]: value });
    return { ...input, conditions };
}

function localRoot() {
    const configured = process.env.EXPORT_LOCAL_DIR || process.cwd();
    return path.resolve(configured, 'exports');
}

function safeLocalPath(key) {
    if (!/^[a-f0-9-]+\.csv$/.test(key)) throw requestError('Invalid export storage key', 500);
    const root = localRoot();
    const target = path.resolve(root, key);
    if (path.dirname(target) !== root) throw requestError('Invalid export storage key', 500);
    return { root, target };
}

async function createLocalWriter(key) {
    if (!['development', 'local', 'test'].includes(process.env.NODE_ENV)) {
        throw requestError('Local export storage is disabled outside development', 503);
    }
    const { root, target } = safeLocalPath(key);
    await fs.promises.mkdir(root, { recursive: true });
    const stream = fs.createWriteStream(target, { flags: 'wx' });
    let size = 0;
    return {
        provider: 'local',
        async write(chunk) { size += Buffer.byteLength(chunk); if (!stream.write(chunk)) await once(stream, 'drain'); },
        async close() { stream.end(); await once(stream, 'close'); return size; },
        async abort() { stream.destroy(); await fs.promises.rm(target, { force: true }); }
    };
}

async function s3Sdk() {
    try { return await import('@aws-sdk/client-s3'); }
    catch { throw requestError('S3 export storage requires @aws-sdk/client-s3', 503); }
}

async function s3Client() {
    const { S3Client } = await s3Sdk();
    return new S3Client({
        region: process.env.EXPORT_S3_REGION || 'us-east-1', endpoint: process.env.EXPORT_S3_ENDPOINT || undefined,
        forcePathStyle: process.env.EXPORT_S3_FORCE_PATH_STYLE === 'true',
        credentials: process.env.EXPORT_S3_ACCESS_KEY_ID ? {
            accessKeyId: process.env.EXPORT_S3_ACCESS_KEY_ID,
            secretAccessKey: process.env.EXPORT_S3_SECRET_ACCESS_KEY
        } : undefined
    });
}

async function createS3Writer(key) {
    const sdk = await s3Sdk();
    const client = await s3Client();
    const Bucket = process.env.EXPORT_S3_BUCKET;
    const Key = `${(process.env.EXPORT_S3_PREFIX || 'exports').replace(/^\/+|\/+$/g, '')}/${key}`;
    const partSize = positiveInt(process.env.EXPORT_S3_PART_SIZE_BYTES, 8 * 1024 * 1024);
    let pending = Buffer.alloc(0), uploadId = null, partNumber = 1, size = 0;
    const parts = [];
    const start = async () => {
        if (uploadId) return;
        const result = await client.send(new sdk.CreateMultipartUploadCommand({ Bucket, Key, ContentType: 'text/csv; charset=utf-8' }));
        uploadId = result.UploadId;
    };
    const upload = async (body) => {
        await start();
        const result = await client.send(new sdk.UploadPartCommand({ Bucket, Key, UploadId: uploadId, PartNumber: partNumber, Body: body }));
        parts.push({ ETag: result.ETag, PartNumber: partNumber++ });
    };
    return {
        provider: 's3', key: Key,
        async write(chunk) {
            const data = Buffer.from(chunk); size += data.length; pending = Buffer.concat([pending, data]);
            while (pending.length >= partSize) { const part = pending.subarray(0, partSize); pending = pending.subarray(partSize); await upload(part); }
        },
        async close() {
            if (!uploadId) await client.send(new sdk.PutObjectCommand({ Bucket, Key, Body: pending, ContentType: 'text/csv; charset=utf-8' }));
            else {
                if (pending.length) await upload(pending);
                await client.send(new sdk.CompleteMultipartUploadCommand({ Bucket, Key, UploadId: uploadId, MultipartUpload: { Parts: parts } }));
            }
            return size;
        },
        async abort() {
            if (uploadId) await client.send(new sdk.AbortMultipartUploadCommand({ Bucket, Key, UploadId: uploadId })).catch(() => {});
            else await client.send(new sdk.DeleteObjectCommand({ Bucket, Key })).catch(() => {});
        }
    };
}

const useS3 = () => Boolean(process.env.EXPORT_S3_BUCKET);
const createWriter = (key) => useS3() ? createS3Writer(key) : createLocalWriter(key);

export async function createExport(raw, scope) {
    const input = await prepareInput(raw, scope);
    const maxActive = positiveInt(process.env.EXPORT_MAX_ACTIVE_PER_ACCOUNT, MAX_ACTIVE_DEFAULT);
    for (let slot = 0; slot < maxActive; slot += 1) {
        try {
            return await LeadExport.create({ acctId: scope.acctId, userId: scope.userId, slot, input });
        } catch (error) {
            if (error?.code !== 11000) throw error;
        }
    }
    throw requestError(`At most ${maxActive} exports may be queued or running for this account`, 429);
}

export const publicExport = doc => ({
    id: doc._id, status: doc.status, processedRows: doc.processedRows, totalRows: doc.totalRows,
    progress: doc.progress, fileName: doc.fileName, sizeBytes: doc.sizeBytes,
    error: doc.error, createdAt: doc.createdAt, startedAt: doc.startedAt,
    completedAt: doc.completedAt, expiresAt: doc.expiresAt,
    downloadUrl: doc.status === 'completed' ? `/api/ui/exports/${doc._id}/download` : null
});

export async function runExport(exportId) {
    const doc = await LeadExport.findOneAndUpdate(
        { _id: exportId, status: 'queued', active: true },
        { status: 'running', startedAt: new Date() }, { new: true }
    );
    if (!doc) return;
    const input = doc.input;
    const projection = Object.fromEntries([...input.fields.map(item => item.field), input.sortBy, '_id'].map(field => [field, 1]));
    const key = `${crypto.randomUUID()}.csv`;
    const writer = await createWriter(key);
    let processedRows = 0, cursor = null;
    try {
        await writer.write('\uFEFF');
        await writer.write(serializeCsvRow(input.fields.map(item => item.label)));
        do {
            const conditions = cursor ? [...input.conditions, buildKeysetCondition(input.sortBy, input.sortOrder, cursor)] : input.conditions;
            const rows = await Lead.find({ $and: conditions }, projection)
                .sort({ [input.sortBy]: input.sortOrder, _id: input.sortOrder }).limit(PAGE_SIZE).maxTimeMS(MAX_TIME_MS).lean();
            for (const row of rows) await writer.write(serializeCsvRow(input.fields.map(item => row[item.field])));
            processedRows += rows.length;
            const last = rows.at(-1);
            cursor = last ? { value: last[input.sortBy] ?? null, id: String(last._id) } : null;
            const state = await LeadExport.findByIdAndUpdate(exportId, { processedRows }, { new: true, projection: { cancelRequested: 1 } });
            if (!state || state.cancelRequested) throw Object.assign(new Error('Export cancelled'), { cancelled: true });
            if (rows.length < PAGE_SIZE) break;
        } while (cursor);
        const sizeBytes = await writer.close();
        const expiresAt = new Date(Date.now() + positiveInt(process.env.EXPORT_TTL_HOURS, 24) * 60 * 60 * 1000);
        const fileName = `leads_${new Date().toISOString().slice(0, 10)}_${exportId.slice(-6)}.csv`;
        await LeadExport.updateOne({ _id: exportId }, {
            status: 'completed', active: false, processedRows, totalRows: processedRows, progress: 100,
            fileName, sizeBytes, storage: { provider: writer.provider, key: writer.key || key },
            completedAt: new Date(), expiresAt
        });
        return { expiresAt };
    } catch (error) {
        await writer.abort().catch(() => {});
        await LeadExport.updateOne({ _id: exportId }, {
            status: error.cancelled ? 'cancelled' : 'failed', active: false,
            error: error.cancelled ? undefined : String(error.message).slice(0, 1000), completedAt: new Date()
        });
        if (!error.cancelled) throw error;
    }
}

export async function deleteStoredExport(doc) {
    if (!doc.storage?.key) return;
    if (doc.storage.provider === 'local') {
        const { target } = safeLocalPath(doc.storage.key);
        await fs.promises.rm(target, { force: true });
        return;
    }
    const sdk = await s3Sdk();
    const client = await s3Client();
    await client.send(new sdk.DeleteObjectCommand({ Bucket: process.env.EXPORT_S3_BUCKET, Key: doc.storage.key }));
}

export async function openDownload(doc) {
    if (doc.status !== 'completed') throw requestError('Export is not ready', 409);
    if (!doc.expiresAt || doc.expiresAt <= new Date()) {
        await deleteStoredExport(doc).catch(() => {});
        await LeadExport.updateOne({ _id: doc._id }, { status: 'expired' });
        throw requestError('Export has expired', 410);
    }
    if (doc.storage.provider === 'local') return fs.createReadStream(safeLocalPath(doc.storage.key).target);
    const sdk = await s3Sdk();
    const client = await s3Client();
    const result = await client.send(new sdk.GetObjectCommand({ Bucket: process.env.EXPORT_S3_BUCKET, Key: doc.storage.key }));
    return result.Body;
}
