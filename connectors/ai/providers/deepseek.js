/**
 * deepseek.js — DeepSeek provider stub
 * ────────────────────────────────────────────────────────────────────────────
 * To activate:
 *   1. npm install openai  (DeepSeek uses OpenAI-compatible API)
 *   2. Add DEEPSEEK_API_KEY to .env
 *   3. Set AI_PROVIDER=deepseek in .env
 *   4. Implement generateAnalyticsCharts below
 * ────────────────────────────────────────────────────────────────────────────
 */
import { buildSystemPrompt, formatHistoryForOpenAI } from '../schemas/analyticsChartSchema.js';

/**
 * @param {string} message
 * @param {Array<{ role: 'user'|'assistant', text: string }>} history
 * @param {Array<{ _id: string, categoryName: string, fields: string[] }>} categoriesWithFields
 * @returns {Promise<object>}
 */
export async function generateAnalyticsCharts(message, history = [], categoriesWithFields = []) {
    // TODO: implement when switching to DeepSeek
    // DeepSeek uses an OpenAI-compatible API:
    //
    // import OpenAI from 'openai';
    // const client = new OpenAI({
    //     apiKey: process.env.DEEPSEEK_API_KEY,
    //     baseURL: 'https://api.deepseek.com',
    // });
    //
    // const messages = [
    //     { role: 'system', content: buildSystemPrompt(categoriesWithFields) },
    //     ...formatHistoryForOpenAI(history),
    //     { role: 'user', content: message },
    // ];
    //
    // const response = await client.chat.completions.create({
    //     model: 'deepseek-chat',
    //     messages,
    //     response_format: { type: 'json_object' },
    //     temperature: 0.3,
    // });
    //
    // return JSON.parse(response.choices[0].message.content);

    throw new Error(
        'DeepSeek provider is not yet implemented. ' +
        'Set AI_PROVIDER=gemini or implement this provider. ' +
        'See comments in connectors/ai/providers/deepseek.js for instructions.'
    );
}
