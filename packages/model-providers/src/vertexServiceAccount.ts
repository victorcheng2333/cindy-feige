/** Main-created credential reference, encrypted in the existing per-connection key store.
 * Contains no private key; the user-selected file remains the source of truth.
 */
export const VERTEX_SERVICE_ACCOUNT_PREFIX = 'cindy-vertex-service-account-v1:';
export interface VertexServiceAccountReference {
  credentialsPath: string;
  project: string;
  location: string;
}
export function vertexServiceAccountEndpoint(location: string): string {
  if (!/^(global|us|eu|[a-z]+(?:-[a-z]+)+[0-9]+)$/.test(location)) throw new Error('Invalid Vertex location');
  if (location === 'us' || location === 'eu') return `https://aiplatform.${location}.rep.googleapis.com`;
  return location === 'global' ? 'https://aiplatform.googleapis.com' : `https://${location}-aiplatform.googleapis.com`;
}
export function parseVertexServiceAccountReference(value: string | null | undefined): VertexServiceAccountReference | undefined {
  if (!value?.startsWith(VERTEX_SERVICE_ACCOUNT_PREFIX)) return undefined;
  try {
    const v = JSON.parse(value.slice(VERTEX_SERVICE_ACCOUNT_PREFIX.length));
    if (typeof v.credentialsPath !== 'string' || !v.credentialsPath || v.credentialsPath.length > 4096 || /[\x00-\x1f]/.test(v.credentialsPath)
      || typeof v.project !== 'string' || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(v.project)
      || typeof v.location !== 'string') throw new Error();
    vertexServiceAccountEndpoint(v.location);
    return { credentialsPath: v.credentialsPath, project: v.project, location: v.location };
  } catch { throw new Error('Invalid Vertex service account reference'); }
}
export function vertexServiceAccountOptions(value: string | null | undefined, api: string, endpoint: string) {
  const reference = parseVertexServiceAccountReference(value);
  if (!reference) return undefined;
  if (api !== 'google-vertex' || endpoint.replace(/\/$/, '') !== vertexServiceAccountEndpoint(reference.location)) {
    throw new Error('Vertex service account requires its configured Google endpoint');
  }
  return { apiKey: 'gcp-vertex-credentials', env: {
    GOOGLE_APPLICATION_CREDENTIALS: reference.credentialsPath,
    GOOGLE_CLOUD_PROJECT: reference.project,
    GOOGLE_CLOUD_LOCATION: reference.location,
  } };
}
