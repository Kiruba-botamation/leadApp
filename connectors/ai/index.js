/**
 * connectors/ai/index.js — AI Provider Factory
 * ────────────────────────────────────────────────────────────────────────────
 * Returns the active AI provider based on the AI_PROVIDER environment variable.
 * Defaults to 'gemini' if not set.
 *
 * To switch providers:
 *   Set AI_PROVIDER=openai | claude | grok | deepseek in .env
 *   Ensure the corresponding provider file is implemented and its SDK installed.
 * ────────────────────────────────────────────────────────────────────────────
 */
import * as gemini from './providers/gemini.js';
import * as openai from './providers/openai.js';
import * as claude from './providers/claude.js';
import * as grok from './providers/grok.js';
import * as deepseek from './providers/deepseek.js';

/** Map of provider names to their implementations */
const PROVIDERS = {
    gemini,
    openai,
    claude,
    grok,
    deepseek,
};

/**
 * Returns the active AI provider module.
 * Each provider must export: generateAnalyticsCharts(message, history, collectionsWithFields)
 *
 * @param {string} [name] - Override provider name (defaults to AI_PROVIDER env var → 'gemini')
 * @returns {{ generateAnalyticsCharts: Function }}
 */
export function getAiProvider(name) {
    const providerName = name || process.env.AI_PROVIDER || 'gemini';
    const provider = PROVIDERS[providerName.toLowerCase()];

    if (!provider) {
        const available = Object.keys(PROVIDERS).join(', ');
        throw new Error(
            `AI provider "${providerName}" is not registered. ` +
            `Available providers: ${available}. ` +
            `Set AI_PROVIDER in your .env file.`
        );
    }

    return provider;
}
