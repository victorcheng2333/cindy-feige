import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVertexServiceAccountSelections, inspectVertexServiceAccount } from '../vertex-service-account.js';
import type { CustomProviderConfig } from '@cindy/model-providers';
let dir: string;
let keyPath: string;
const scope = { sender: {}, owner: 'account-a:1' };
const config: CustomProviderConfig = { id: 'vertex-test', name: 'Vertex', runtimes: { pi: {
  catalogPresetId: 'google-vertex', baseUrl: 'https://aiplatform.googleapis.com', wireProtocol: 'google-generative-ai', models: [{ id: 'gemini-fixture', name: 'Gemini', api: 'google-vertex' }],
} } };
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cindy-vertex-test-'));
  keyPath = join(dir, '服务账号.json');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await writeFile(keyPath, JSON.stringify({ type: 'service_account', project_id: 'project-test', client_email: 'fixture@project-test.iam.gserviceaccount.com', token_uri: 'https://oauth2.googleapis.com/token', private_key: privateKey }));
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
describe('Vertex file authorization', () => {
  it('returns metadata only, resolves only for the selecting sender and account', async () => {
    const selections = createVertexServiceAccountSelections();
    const selected = await selections.select(keyPath, scope);
    expect(Object.keys(selected).sort()).toEqual(['fileName', 'project', 'selectionId']);
    const input = { selectionId: selected.selectionId, project: selected.project, location: 'global' };
    await expect(selections.resolve(input, config, { ...scope, owner: 'account-b:2' })).rejects.toThrow();
    await expect(selections.resolve(input, config, { ...scope, sender: {} })).rejects.toThrow();
    const key = await selections.resolve(input, config, scope);
    expect(key).toContain('project-test');
    expect(key).not.toContain('PRIVATE KEY');
    expect(() => new Headers({ authorization: 'Bearer ' + key })).not.toThrow();
    selections.consume(selected.selectionId);
    await expect(selections.resolve(input, config, scope)).rejects.toThrow();
  });
  it('rejects invalid JSON without returning its contents', async () => {
    const invalid = join(dir, 'invalid.json');
    await writeFile(invalid, 'private-secret-fixture');
    await expect(inspectVertexServiceAccount(invalid)).rejects.toThrow('Invalid Google service account JSON file');
  });
  it('rejects destination and model route overrides before creating a credential', async () => {
    const selections = createVertexServiceAccountSelections();
    const selected = await selections.select(keyPath, scope);
    const input = { selectionId: selected.selectionId, project: selected.project, location: 'global' };
    const altered = structuredClone(config);
    altered.runtimes.pi!.baseUrl = 'https://attacker.example';
    await expect(selections.resolve(input, altered, scope)).rejects.toThrow();
    altered.runtimes.pi!.baseUrl = config.runtimes.pi!.baseUrl;
    altered.runtimes.pi!.models[0]!.api = 'openai-completions';
    await expect(selections.resolve(input, altered, scope)).rejects.toThrow();
  });
});
