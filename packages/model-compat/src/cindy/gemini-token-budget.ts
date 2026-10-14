/** Match the upstream Gemini family, including gateway namespaces and CC window suffixes. */
export function isGeminiModelId(model: unknown): model is string {
  return typeof model === 'string' && /^(?:google\/)?gemini-/i.test(model);
}

/** Only a standalone runtime counter is safe to demote; never rewrite mixed instructions. */
export function isStandaloneClaudeTokenBudget(content: unknown): boolean {
  let text = content;
  if (Array.isArray(content)) {
    if (content.length !== 1) return false;
    const block = content[0];
    if (!block || typeof block !== 'object' || block.type !== 'text') return false;
    text = block.text;
  }
  return typeof text === 'string' && /^<total_tokens>\d+ tokens left<\/total_tokens>$/.test(text.trim());
}

/**
 * Gemini gateways may hoist every Anthropic system message into systemInstruction.
 * Keep CC's appended token counters in the conversation before any such translation.
 * Leave policy text, block metadata, tools and history order intact. A clean request
 * returns null so the proxy can retain its byte-for-byte forwarding contract.
 */
export function preserveGeminiTokenBudgetMessages(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const request = body as Record<string, unknown>;
  if (!isGeminiModelId(request.model) || !Array.isArray(request.messages)) return null;
  let seenConversation = false;
  let messages: unknown[] | undefined;
  for (let index = 0; index < request.messages.length; index++) {
    const message = request.messages[index];
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    if (message.role === 'user' || message.role === 'assistant') seenConversation = true;
    if (seenConversation && message.role === 'system' && isStandaloneClaudeTokenBudget(message.content)) {
      messages ??= [...request.messages];
      messages[index] = { ...message, role: 'user' };
    }
  }
  return messages ? { ...request, messages } : null;
}
