import { describe, expect, it } from 'vitest';
import { VERTEX_SERVICE_ACCOUNT_PREFIX, parseVertexServiceAccountReference, vertexServiceAccountOptions } from '../vertexServiceAccount.js';
const reference = (project = 'project-one', location = 'global') => VERTEX_SERVICE_ACCOUNT_PREFIX + JSON.stringify({ credentialsPath: '/fixture/key.json', project, location });
describe('Vertex service account references', () => {
  it('keeps API key credentials unchanged and isolates two cloud identities', () => {
    expect(vertexServiceAccountOptions('ordinary-api-key', 'google-vertex', 'https://example.com')).toBeUndefined();
    const first = vertexServiceAccountOptions(reference(), 'google-vertex', 'https://aiplatform.googleapis.com');
    const second = vertexServiceAccountOptions(reference('project-two', 'us-central1'), 'google-vertex', 'https://us-central1-aiplatform.googleapis.com');
    expect(first?.env.GOOGLE_CLOUD_PROJECT).toBe('project-one');
    expect(second?.env.GOOGLE_CLOUD_PROJECT).toBe('project-two');
    expect(first?.apiKey).toBe('gcp-vertex-credentials');
  });
  it('rejects malformed credentials, wrong protocols and changed destinations', () => {
    expect(() => parseVertexServiceAccountReference(VERTEX_SERVICE_ACCOUNT_PREFIX + '{}')).toThrow();
    for (const [api, url] of [['openai-completions', 'https://aiplatform.googleapis.com'], ['google-vertex', 'https://attacker.example'], ['google-vertex', 'https://aiplatform.googleapis.com/path']]) {
      expect(() => vertexServiceAccountOptions(reference(), api, url)).toThrow();
    }
    expect(() => vertexServiceAccountOptions(reference('bad/project'), 'google-vertex', 'https://aiplatform.googleapis.com')).toThrow();
  });
});
