import { open } from 'node:fs/promises';
import { isAbsolute, basename } from 'node:path';
import { createPrivateKey, randomUUID } from 'node:crypto';
import { VERTEX_SERVICE_ACCOUNT_PREFIX, vertexServiceAccountOptions } from '@cindy/model-providers';
import type { CustomProviderConfig } from '@cindy/model-providers';
import type { VertexServiceAccountSave, VertexServiceAccountSelection } from '../../shared/vertexServiceAccount.js';

const MAX_BYTES = 64 * 1024;
/** Read only a bounded regular file; never forward JSON/parser/crypto errors containing input. */
export async function inspectVertexServiceAccount(path: string): Promise<{ project: string }> {
  if (!isAbsolute(path)) throw new Error('Select an absolute service account file');
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error();
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) throw new Error();
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    if (value.type !== 'service_account' || typeof value.project_id !== 'string'
      || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(value.project_id)
      || typeof value.client_email !== 'string' || !value.client_email.endsWith('.gserviceaccount.com')
      || value.token_uri !== 'https://oauth2.googleapis.com/token'
      || typeof value.private_key !== 'string' || createPrivateKey(value.private_key).asymmetricKeyType !== 'rsa') throw new Error();
    return { project: value.project_id };
  } catch { throw new Error('Invalid Google service account JSON file'); }
  finally { await file.close(); }
}

type Scope = { sender: unknown; owner: string };
/** Bounded ephemeral grants; raw paths from renderer are never accepted as file authorization. */
export function createVertexServiceAccountSelections() {
  const selections = new Map<string, Scope & { path: string; expires: number }>();
  return {
    async select(path: string, scope: Scope): Promise<VertexServiceAccountSelection> {
      const metadata = await inspectVertexServiceAccount(path);
      for (const [id, value] of selections) if (value.expires < Date.now() || value.sender === scope.sender) selections.delete(id);
      if (selections.size >= 32) throw new Error('Too many pending service account selections');
      const selectionId = randomUUID();
      selections.set(selectionId, { ...scope, path, expires: Date.now() + 30 * 60_000 });
      return { selectionId, fileName: basename(path), project: metadata.project };
    },
    async resolve(input: VertexServiceAccountSave, config: CustomProviderConfig, scope: Scope): Promise<string> {
      if (!input || typeof input.selectionId !== 'string') throw new Error('Select a service account file');
      const grant = selections.get(input.selectionId);
      if (!grant || grant.sender !== scope.sender || grant.owner !== scope.owner || grant.expires < Date.now()) throw new Error('Service account selection expired');
      await inspectVertexServiceAccount(grant.path);
      // References travel through the existing loopback authorization carrier: keep it ASCII,
      // including when the user's selected filename contains Chinese or other Unicode.
      const key = VERTEX_SERVICE_ACCOUNT_PREFIX + JSON.stringify({ credentialsPath: grant.path, project: input.project, location: input.location })
        .replace(/[^\x20-\x7e]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
      for (const runtime of Object.values(config.runtimes)) {
        if (!runtime || runtime.catalogPresetId !== 'google-vertex' || runtime.headers || runtime.modelsUrl || runtime.requestPath) throw new Error('Invalid Vertex connection');
        vertexServiceAccountOptions(key, 'google-vertex', runtime.baseUrl);
        for (const model of runtime.models) {
          if ((model.api && model.api !== 'google-vertex') || (model.piApi && model.piApi !== 'google-vertex') || model.route) throw new Error('Invalid Vertex model route');
        }
      }
      return key;
    },
    consume(id: string) { selections.delete(id); },
  };
}
