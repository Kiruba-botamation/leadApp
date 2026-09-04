/**
 * claude.js — Anthropic Claude provider stub
 * ────────────────────────────────────────────────────────────────────────────
 * To activate:
 *   1. npm install @anthropic-ai/sdk
 *   2. Add ANTHROPIC_API_KEY to .env
 *   3. Set AI_PROVIDER=claude in .env
 *   4. Implement generateAnalyticsCharts below
 * ────────────────────────────────────────────────────────────────────────────
 */
import { buildSystemPrompt, responseJsonSchema, formatHistoryForOpenAI } from '../schemas/analyticsChartSchema.js';

/**
 * @param {string} message
 * @param {Array<{ role: 'user'|'assistant', text: string }>} history
 * @param {Array<{ _id: string, collectionName: string, fields: Array<{field: string, label: string, type: string}> }>} collectionsWithFields
 * @returns {Promise<object>}
 */
export async function generateAnalyticsCharts(message, history = [], collectionsWithFields = []) {
    // TODO: implement when switching to Claude
    // Example implementation:
    //
    // import Anthropic from '@anthropic-ai/sdk';
    // const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    //
    // const messages = [
    //     ...formatHistoryForOpenAI(history),  // Claude uses same role format as OpenAI
    //     { role: 'user', content: message },
    // ];
    //
    // const response = await client.messages.create({
    //     model: 'claude-3-5-sonnet-20241022',
    //     max_tokens: 2048,
    //     system: buildSystemPrompt(collectionsWithFields),
    //     messages,
    // });
    //
    // return JSON.parse(response.content[0].text);

    throw new Error(
        'Claude provider is not yet implemented. ' +
        'Set AI_PROVIDER=gemini or implement this provider. ' +
        'See comments in connectors/ai/providers/claude.js for instructions.'
    );
}
