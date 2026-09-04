import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const CONFIRMATION = 'GENERATE_LOCAL_LEAD_FIXTURE';
const DEFAULT_COUNT = 100_000;
const MAX_COUNT = 1_000_000;

export function buildLeadFixture(index, acctId, collectionCount = 10) {
    const padded = String(index).padStart(7, '0');
    const day = String((index % 28) + 1).padStart(2, '0');
    return {
        _id: `perf-${acctId}-${padded}`,
        acctId,
        collectionId: `perf-collection-${index % collectionCount}`,
        name: `Performance Lead ${padded}`,
        email: `performance-${padded}@example.invalid`,
        phone: `900${String(index).padStart(7, '0')}`,
        stage: index % 6,
        responsible: `perf-user-${index % 25}`,
        createdAt: `2026-01-${day}T00:00:00.000Z`,
        updatedAt: `2026-02-${day}T00:00:00.000Z`
    };
}

export async function generateFixture({ output, acctId, count = DEFAULT_COUNT }) {
    if (!output) throw new Error('--output is required');
    if (!acctId) throw new Error('--acct-id is required');
    if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
        throw new Error(`--count must be an integer between 1 and ${MAX_COUNT}`);
    }

    const stream = createWriteStream(output, { flags: 'wx', encoding: 'utf8' });
    for (let index = 0; index < count; index += 1) {
        if (!stream.write(`${JSON.stringify(buildLeadFixture(index, acctId))}\n`)) await once(stream, 'drain');
    }
    stream.end();
    await once(stream, 'finish');
}

function argument(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? null : process.argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    if (process.env.PERFORMANCE_FIXTURE_CONFIRM !== CONFIRMATION) {
        console.error(`Set PERFORMANCE_FIXTURE_CONFIRM=${CONFIRMATION} to create a local NDJSON fixture`);
        process.exitCode = 1;
    } else {
        const countValue = argument('--count');
        generateFixture({
            output: argument('--output'),
            acctId: argument('--acct-id'),
            count: countValue === null ? DEFAULT_COUNT : Number(countValue)
        }).then(() => console.log('Fixture generated. No database was contacted.')).catch(error => {
            console.error(`[fixture-generator] ${error.message}`);
            process.exitCode = 1;
        });
    }
}
