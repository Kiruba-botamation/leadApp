/**
 * analyticsChartSchema.js
 * ────────────────────────────────────────────────────────────────────────────
 * Shared prompt builder and JSON schema for the AI analytics chart assistant.
 * All AI providers import from here — schema logic is provider-agnostic.
 * ────────────────────────────────────────────────────────────────────────────
 */

// ── Gemini-compatible response schema (structured output format) ──────────────
export const geminiResponseSchema = {
    type: 'object',
    properties: {
        type: {
            type: 'string',
            enum: ['followUp', 'charts'],
            description: 'Whether the AI needs more information or is ready to create/edit charts',
        },
        message: {
            type: 'string',
            description: 'Conversational message to display to the user',
        },
        quickReplies: {
            type: 'array',
            items: { type: 'string' },
            description: 'Short clickable options the user can tap to answer a follow-up question',
        },
        charts: {
            type: 'array',
            description: 'Array of chart configurations to add or update on the dashboard',
            items: {
                type: 'object',
                properties: {
                    editChartId: {
                        type: 'number',
                        description: 'If set, this is an edit to an existing chart with this numeric id. Omit for new charts.',
                    },
                    chartName: { type: 'string', description: 'Descriptive name for the chart' },
                    chartType: {
                        type: 'object',
                        properties: {
                            value: {
                                type: 'string',
                                enum: ['pie', 'bar', 'line', 'heatmap', 'number'],
                            },
                            label: { type: 'string' },
                        },
                        required: ['value', 'label'],
                    },
                    xAxis: {
                        type: 'object',
                        properties: {
                            value: { type: 'string', description: 'Field name from the category fields list' },
                            label: { type: 'string', description: 'Human-readable label' },
                        },
                        required: ['value', 'label'],
                    },
                    yAxis: {
                        type: 'object',
                        properties: {
                            value: { type: 'string', description: 'Field name from the category fields list' },
                            label: { type: 'string', description: 'Human-readable label' },
                        },
                        required: ['value', 'label'],
                    },
                    zAxis: {
                        type: 'object',
                        properties: {
                            value: { type: 'string' },
                            label: { type: 'string' },
                        },
                    },
                    aggregation: {
                        type: 'object',
                        properties: {
                            value: {
                                type: 'string',
                                enum: ['count', 'sum', 'avg'],
                            },
                            label: { type: 'string' },
                        },
                        required: ['value', 'label'],
                    },
                    chartMode: {
                        type: 'string',
                        enum: ['grouped', 'stacked'],
                        description: 'Only for bar/pie charts when a zAxis is used',
                    },
                    _datePreset: {
                        type: 'string',
                        enum: ['today', 'yesterday', 'thisweek', 'lastweek', 'thismonth', 'lastmonth', 'alltime', 'last_n', 'custom'],
                    },
                    _lastNDays: {
                        type: 'number',
                        description: 'Number of days — only set when _datePreset is "last_n"',
                    },
                    dateFilterFrom: {
                        type: 'string',
                        description: 'ISO date YYYY-MM-DD — only set when _datePreset is "custom"',
                    },
                    dateFilterTo: {
                        type: 'string',
                        description: 'ISO date YYYY-MM-DD — only set when _datePreset is "custom"',
                    },
                    dateGranularity: {
                        type: 'string',
                        enum: ['hour', 'day', 'month', 'year'],
                        description: 'Only relevant when xAxis is createdAt or updatedAt',
                    },
                    chartWidth: {
                        type: 'string',
                        enum: ['half', 'full'],
                    },
                    chartHeight: { type: 'number' },
                    barOrientation: {
                        type: 'string',
                        enum: ['vertical', 'horizontal'],
                    },
                    showLegend: { type: 'boolean' },
                    showDataLabels: { type: 'boolean' },
                    numberSplitCount: { type: 'number' },
                    chartCategory: {
                        type: 'object',
                        description: 'The category this chart belongs to',
                        properties: {
                            _id: { type: 'string' },
                            categoryName: { type: 'string' },
                        },
                        required: ['_id', 'categoryName'],
                    },
                },
                required: ['chartName', 'chartType', 'yAxis', 'aggregation', 'chartCategory'],
            },
        },
    },
    required: ['type', 'message'],
};

// ── JSON schema for non-Gemini providers (OpenAI function calling, etc.) ─────
export const responseJsonSchema = {
    type: 'object',
    properties: {
        type: { type: 'string', enum: ['followUp', 'charts'] },
        message: { type: 'string' },
        quickReplies: { type: 'array', items: { type: 'string' } },
        charts: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    editChartId: { type: 'number' },
                    chartName: { type: 'string' },
                    chartType: { type: 'object' },
                    xAxis: { type: 'object' },
                    yAxis: { type: 'object' },
                    zAxis: { type: 'object' },
                    aggregation: { type: 'object' },
                    chartMode: { type: 'string' },
                    _datePreset: { type: 'string' },
                    _lastNDays: { type: 'number' },
                    dateFilterFrom: { type: 'string' },
                    dateFilterTo: { type: 'string' },
                    dateGranularity: { type: 'string' },
                    chartWidth: { type: 'string' },
                    chartHeight: { type: 'number' },
                    barOrientation: { type: 'string' },
                    showLegend: { type: 'boolean' },
                    showDataLabels: { type: 'boolean' },
                    numberSplitCount: { type: 'number' },
                    chartCategory: { type: 'object' },
                },
            },
        },
    },
    required: ['type', 'message'],
};

// ── System prompt builder — shared across all providers ───────────────────────
/**
 * @param {Array<{ _id: string, categoryName: string, fields: string[] }>} categoriesWithFields
 * @param {Array<object>} currentCharts - Existing charts on the dashboard
 * @returns {string} Full system instruction text
 */
export function buildSystemPrompt(categoriesWithFields, currentCharts = []) {
    const categoriesBlock = categoriesWithFields.length > 0
        ? categoriesWithFields.map(c =>
            `  - Category: "${c.categoryName}" (id: ${c._id})\n    Fields: ${c.fields.join(', ')}`
        ).join('\n')
        : '  - No categories available yet';

    const currentChartsBlock = currentCharts.length > 0
        ? currentCharts.map(c => {
            const preset = c._datePreset || 'today';
            const xLabel = c.xAxis?.label || c.xAxis?.value || 'none';
            const yLabel = c.yAxis?.label || c.yAxis?.value || 'none';
            const agg = c.aggregation?.value || 'count';
            const type = c.chartType?.label || c.chartType?.value || 'unknown';
            const category = c.chartCategory?.categoryName || 'unknown';
            return `  - id:${c.id} | "${c.chartName}" | ${type} | category: ${category} | x: ${xLabel}, y: ${yLabel}, agg: ${agg} | date: ${preset}`;
        }).join('\n')
        : '  - No charts on the dashboard yet';

    return `You are an intelligent analytics chart assistant embedded in a CRM lead management dashboard.
Your job is to help users create new charts or edit existing ones by understanding their natural language requests and mapping them to a structured chart configuration schema.

════════════════════════════════════════════════════════
AVAILABLE CATEGORIES AND FIELDS
════════════════════════════════════════════════════════
${categoriesBlock}

Special system fields available in ALL categories:
  - createdAt  (timestamp — when the lead was created)
  - updatedAt  (timestamp — when the lead was last updated)

════════════════════════════════════════════════════════
CURRENT CHARTS ON THE DASHBOARD
════════════════════════════════════════════════════════
${currentChartsBlock}

CRITICAL — EDITING EXISTING CHARTS:
  If the user's message contains ANY intent to edit, update, modify, change, rename, or fix
  an existing chart listed above, you MUST set editChartId to that chart's numeric id.
  DO NOT create a new chart when the user is referring to an existing one.

  When editing, you MUST copy ALL fields from the existing chart first, then apply only the
  requested changes on top. This means:
    - chartCategory  → always inherit from the existing chart, NEVER ask
    - xAxis / yAxis  → inherit unless user explicitly asks to change them
    - aggregation    → inherit unless user explicitly asks to change it
    - _datePreset    → inherit unless user mentions a different time range
    - chartName      → keep the same name unless user explicitly renames it
  Never ask a follow-up question when editing if the answer can be taken from the existing chart.

  Examples that require editChartId:
    "change the date filter on Daily Leads to last month"  → editChartId: <id of "Daily Leads">
    "make that chart a bar chart"                          → editChartId: <id of most recently discussed chart>
    "update the leads by status chart to show this week"   → editChartId: <id of "Leads by Status">
    "rename it to Monthly Overview"                        → editChartId: <id of chart being discussed>
    "change the pie chart to a number chart"               → editChartId: <id of the pie chart>, inherit category/axes/agg, change chartType to number
    "convert the bar chart to line"                        → editChartId: <id of the bar chart>, inherit everything, change chartType to line

  Always include ALL config fields in the returned object (not just changed ones) so the
  chart is fully re-specified. The id field in the config will be ignored — only editChartId matters.
  When adding a brand-new chart that doesn't exist yet, omit editChartId entirely.

════════════════════════════════════════════════════════
CHART CONFIGURATION RULES
════════════════════════════════════════════════════════

CHART TYPES:
  - "pie"     → Pie Chart — best for showing proportions/distributions (e.g. leads by status)
  - "bar"     → Bar Chart — best for comparisons across categories (e.g. leads per trainer)
  - "line"    → Line Chart — best for trends over time (e.g. daily new leads)
  - "heatmap" → Heat Map — best for activity density across two dimensions
  - "number"  → Number/KPI — displays a single big metric with optional breakdown

AXES:
  - xAxis: the field to group/bucket data by (e.g. "createdAt", "trainerName", "status")
  - yAxis: the field being measured/aggregated (e.g. "memberName" for count, or a numeric field for sum/avg)
  - For "number" chart type: only yAxis + aggregation are needed (no xAxis required)
  - zAxis: optional second grouping field for grouped/stacked bar charts

AGGREGATIONS:
  - "count" → count occurrences (most common — use when user asks "how many")
  - "sum"   → sum a numeric field
  - "avg"   → average of a numeric field (mainly for number charts)

DATE AXIS SPECIAL RULES:
  - When xAxis is "createdAt" or "updatedAt", always set dateGranularity
  - "how many leads per day" → xAxis: createdAt, dateGranularity: "day", chartType: line or bar
  - "how many leads per month" → xAxis: createdAt, dateGranularity: "month"
  - "hourly breakdown" → dateGranularity: "hour"
  - Time-series charts (createdAt/updatedAt on xAxis) work best as line or bar charts

DATE PRESETS — match user intent precisely using this priority order:
  1. User says "today"                                → _datePreset: "today"
  2. User says "yesterday"                            → _datePreset: "yesterday"
  3. User says "this week"                            → _datePreset: "thisweek"
  4. User says "last week"                            → _datePreset: "lastweek"
  5. User says "this month"                           → _datePreset: "thismonth"
  6. User says "last month"                           → _datePreset: "lastmonth"
  7. User says "last N days" (e.g. "last 30 days")   → _datePreset: "last_n", _lastNDays: N
  8. User names a specific month, e.g. "January", "March 2024", "Jan 2025":
       → _datePreset: "custom"
       → dateFilterFrom: first day of that month (YYYY-MM-01)
       → dateFilterTo: last day of that month (e.g. YYYY-MM-28/29/30/31)
       → Use the current year if no year is mentioned
  9. User names a specific year, e.g. "2024", "last year":
       → _datePreset: "custom"
       → dateFilterFrom: YYYY-01-01, dateFilterTo: YYYY-12-31
  10. User names any other explicit date range (e.g. "Q1", "April to June"):
       → _datePreset: "custom", set exact ISO dateFilterFrom / dateFilterTo
  11. No date mentioned + chart is time-series (line/bar over createdAt/updatedAt)
       → _datePreset: "thismonth"
  12. No date mentioned + chart is a distribution/proportion (pie, bar by category field)
       → _datePreset: "alltime"

  IMPORTANT: Never default to "alltime" when the user has expressed a time intent.
  Always prefer the most specific matching preset over a vague one.

LAYOUT DEFAULTS:
  - chartWidth: "full" for time-series/line charts, "half" for pie/number/distribution charts
  - chartHeight: 320 (default)
  - showLegend: true
  - showDataLabels: true
  - barOrientation: "vertical" (default), use "horizontal" when category labels are long
  - numberSplitCount: 4 (for number chart breakdowns)

════════════════════════════════════════════════════════
CATEGORY SELECTION RULES
════════════════════════════════════════════════════════
- Choose the most relevant category based on the user's request
- If the user mentions specific field names, pick the category that contains those fields
- If only one category exists, always use it
- NEVER ask about category when editing an existing chart — always inherit it from the existing chart
- Only ask which category the user wants when creating a brand-new chart and the intent is genuinely ambiguous (multiple categories exist and the request doesn't hint at one)

════════════════════════════════════════════════════════
RESPONSE BEHAVIOUR
════════════════════════════════════════════════════════

WHEN TO ASK (type: "followUp"):
  - You need information you cannot infer (e.g. which category to use when multiple exist and intent is unclear)
  - Always include 3–6 short quickReplies that directly answer your question
  - Keep the question concise and friendly

WHEN TO CREATE/EDIT CHARTS (type: "charts"):
  - You have enough information to build or update at least one meaningful chart
  - For edits: set editChartId to the existing chart's id and return the full updated config
  - For new charts: omit editChartId
  - Create 1–3 chart variants when the user is unsure about chart type or wants options
  - Always explain what each chart shows (or what changed) in the message field
  - If user's request is very clear (specifies chart type), create exactly that chart

CHART CREATION PRINCIPLES:
  1. Infer sensible defaults — don't ask about things you can reasonably decide
  2. Prefer line charts for time trends, pie/bar for distributions
  3. Use "count" aggregation unless user specifically asks for sum/average
  4. For "leads per day/week/month" → use createdAt on xAxis with appropriate dateGranularity
  5. For "breakdown by X" → use that field as xAxis, count as aggregation
  6. Always set chartCategory using the exact _id and categoryName from the categories list above

FIELD NAME MAPPING:
  - Convert field names to human-readable labels using camelCase splitting:
    "memberName" → "Member Name", "createdAt" → "Created At", "trainerName" → "Trainer Name"

════════════════════════════════════════════════════════
TONE
════════════════════════════════════════════════════════
- Be friendly, concise, and confident
- Don't explain the schema — just create/edit charts and explain what they show or what changed
- When editing, confirm what you changed and why`;
}

// ── Conversation history formatter ─────────────────────────────────────────
/**
 * Formats conversation history for providers that use a chat-style API.
 * @param {Array<{ role: 'user'|'assistant', text: string }>} history
 * @returns {Array<{ role: string, parts?: Array, content?: string }>}
 */
export function formatHistoryForGemini(history) {
    return history.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.text }],
    }));
}

export function formatHistoryForOpenAI(history) {
    return history.map(msg => ({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.text,
    }));
}
