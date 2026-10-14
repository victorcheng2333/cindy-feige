// Official Vertex model, verified 2026-10-14:
// https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/4-argon
// https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-argon
// Native Google API has a unified 1M context. Cindy uses the normal streaming output cap;
// long-decode continuation and vendor tools are not implied by this catalog addition.
export function applyVertexArgonAddition(providers) {
  const rows = providers['google-vertex'] ??= [];
  if (rows.some(row => row.id === 'gemini-4-argon')) return;
  rows.push({
    id: 'gemini-4-argon', name: 'Gemini 4 Argon', provider: 'google-vertex',
    api: 'google-vertex', nativeApi: 'google-generative-ai',
    baseUrl: 'https://{location}-aiplatform.googleapis.com',
    contextWindow: 1048576, maxTokens: 65536,
    // Global Standard effective promotional rates in USD / 1M tokens, verified 2026-10-14.
    // https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing
    // Vertex applies the promotion as 50% credits back through 2026-11-30.
    // From 2026-12-01 use 4 / 20 / 0.2; non-global endpoints cost 10% more.
    // This static catalog does not switch rates by date or endpoint region.
    cost: { input: 2, output: 10, cacheRead: 0.1 },
    input: ['text', 'image'], reasoning: true, reasoningRequired: true,
    supportsToolCalls: true, defaultEffort: 'medium',
    thinkingLevelMap: { off: null, minimal: null, low: 'LOW', medium: 'MEDIUM', high: 'HIGH', xhigh: null, max: null },
  });
}
