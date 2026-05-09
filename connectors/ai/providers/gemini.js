/**
 * gemini.js — Google Gemini AI provider
 * ────────────────────────────────────────────────────────────────────────────
 * Implements the standard provider interface:
 *   generateAnalyticsCharts(message, history, categoriesWithFields) → response
 * ────────────────────────────────────────────────────────────────────────────
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import {
    buildSystemPrompt,
    geminiResponseSchema,
    formatHistoryForGemini,
} from '../schemas/analyticsChartSchema.js';

const MODEL_NAME = 'gemini-2.5-flash';

/**
 * Generate analytics chart configurations using Google Gemini.
 *
 * @param {string} message - Latest user message
 * @param {Array<{ role: 'user'|'assistant', text: string }>} history - Prior conversation turns
 * @param {Array<{ _id: string, categoryName: string, fields: string[] }>} categoriesWithFields
 * @returns {Promise<{ type: 'followUp'|'charts', message: string, quickReplies?: string[], charts?: object[] }>}
 */
export async function generateAnalyticsCharts(message, history = [], categoriesWithFields = [], currentCharts = []) {
    if (!process.env.GOOGLE_AI_API_KEY) {
        throw new Error('GOOGLE_AI_API_KEY is not configured. Add it to your .env file.');
    }

    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);

    const model = genAI.getGenerativeModel({
        model: MODEL_NAME,
        systemInstruction: {
            parts: [{ text: buildSystemPrompt(categoriesWithFields, currentCharts) }],
        },
        generationConfig: {
            temperature: 0.3,
            responseMimeType: 'application/json',
            responseSchema: geminiResponseSchema,
        },
    });

    // Build conversation history for multi-turn chat
    const formattedHistory = formatHistoryForGemini(history);

    // Start a chat session with prior history so Gemini has full context
    const chat = model.startChat({ history: formattedHistory });

    // Send the latest user message
    const result = await chat.sendMessage(message);
    const response = result.response;
    const text = response.text();

    // Parse structured JSON response
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (parseError) {
        console.error('[Gemini] Failed to parse response as JSON:', parseError.message);
        console.error('[Gemini] Raw response:', text);
        throw new Error('AI returned an unexpected response format. Please try again.');
    }

    // Validate required fields
    if (!parsed.type || !parsed.message) {
        console.error('[Gemini] Response missing required fields:', parsed);
        throw new Error('AI response is incomplete. Please try again.');
    }

    // Normalise: ensure charts array is present when type is 'charts'
    if (parsed.type === 'charts' && !Array.isArray(parsed.charts)) {
        parsed.charts = [];
    }

    // Normalise: ensure quickReplies array is present when type is 'followUp'
    if (parsed.type === 'followUp' && !Array.isArray(parsed.quickReplies)) {
        parsed.quickReplies = [];
    }

    return parsed;
}
