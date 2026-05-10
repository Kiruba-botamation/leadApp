/**
 * openai.js — OpenAI provider stub
 * ────────────────────────────────────────────────────────────────────────────
 * To activate:
 *   1. npm install openai
 *   2. Add OPENAI_API_KEY to .env
 *   3. Set AI_PROVIDER=openai in .env
 *   4. Implement generateAnalyticsCharts below
 * ────────────────────────────────────────────────────────────────────────────
 */
import { buildSystemPrompt, responseJsonSchema, formatHistoryForOpenAI } from '../schemas/analyticsChartSchema.js';

/**
 * @param {string} message
 * @param {Array<{ role: 'user'|'assistant', text: string }>} history
 * @param {Array<{ _id: string, categoryName: string, fields: string[] }>} categoriesWithFields
 * @returns {Promise<object>}
 */
export async function generateAnalyticsCharts(message, history = [], categoriesWithFields = []) {
    // TODO: implement when switching to OpenAI
    // Example implementation:
    //
    // import OpenAI from 'openai';
    // const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    //
    // const messages = [
    //     { role: 'system', content: buildSystemPrompt(categoriesWithFields) },
    //     ...formatHistoryForOpenAI(history),
    //     { role: 'user', content: message },
    // ];
    //
    // const response = await client.chat.completions.create({
    //     model: 'gpt-4o',
    //     messages,
    //     response_format: { type: 'json_object' },
    //     temperature: 0.3,
    // });
    //
    // return JSON.parse(response.choices[0].message.content);

    throw new Error(
        'OpenAI provider is not yet implemented. ' +
        'Set AI_PROVIDER=gemini or implement this provider. ' +
        'See comments in connectors/ai/providers/openai.js for instructions.'
    );
}
