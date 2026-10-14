/** Pi versions that predate Argon emit thinkingBudget for non-Gemini-3 IDs.
 * Keep the native SDK and serializers, correcting only this model's documented
 * request parameters via its public onPayload hook. No long-decode claim.
 */
export function vertexArgonPayload(payload: unknown, reasoning?: string): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const request = payload as Record<string, unknown>;
  const config = request.config && typeof request.config === 'object' ? request.config as Record<string, unknown> : {};
  const { temperature: _temperature, topP: _topP, topK: _topK, ...rest } = config;
  const level = reasoning === 'low' ? 'LOW' : reasoning === 'high' ? 'HIGH' : 'MEDIUM';
  return { ...request, config: { ...rest, thinkingConfig: { includeThoughts: true, thinkingLevel: level } } };
}
