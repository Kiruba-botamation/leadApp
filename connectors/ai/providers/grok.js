/**
 * grok.js — xAI Grok provider stub
 * ────────────────────────────────────────────────────────────────────────────
 * To activate:
 *   1. npm install openai  (Grok uses OpenAI-compatible API)
 *   2. Add XAI_API_KEY to .env
 *   3. Set AI_PROVIDER=grok in .env
 *   4. Implement generateAnalyticsCharts below
 * ────────────────────────────────────────────────────────────────────────────
 */
import { buildSystemPrompt, formatHistoryForOpenAI } from '../schemas/analyticsChartSchema.js';

/**
 * @param {string} message
 * @param {Array<{ role: 'user'|'assistant', text: string }>} history
 * @param {Array<{ _id: string, collectionName: string, fields: Array<{field: string, label: string, type: string}> }>} collectionsWithFields
 * @returns {Promise<object>}
 */
export async function generateAnalyticsCharts(message, history = [], collectionsWithFields = []) {
    // TODO: implement when switching to Grok
    // Grok uses an OpenAI-compatible API with a different base URL:
    //
    // import OpenAI from 'openai';
    // const client = new OpenAI({
    //     apiKey: process.env.XAI_API_KEY,
    //     baseURL: 'https://api.x.ai/v1',
    // });
    //
    // const messages = [
    //     { role: 'system', content: buildSystemPrompt(collectionsWithFields) },
    //     ...formatHistoryForOpenAI(history),
    //     { role: 'user', content: message },
    // ];
    //
    // const response = await client.chat.completions.create({
    //     model: 'grok-2-latest',
    //     messages,
    //     response_format: { type: 'json_object' },
    //     temperature: 0.3,
    // });
    //
    // return JSON.parse(response.choices[0].message.content);

    throw new Error(
        'Grok provider is not yet implemented. ' +
        'Set AI_PROVIDER=gemini or implement this provider. ' +
        'See comments in connectors/ai/providers/grok.js for instructions.'
    );
}
