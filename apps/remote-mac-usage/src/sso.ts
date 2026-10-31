import { createHash, randomBytes } from 'node:crypto';
import type { CindyAuthClient, LoginOutcome } from '../../../packages/auth-client/src/index';
import endpoints from '../../../config/endpoint.json';

export function createProof() {
  const verifier = randomBytes(32).toString('base64url'), pollSecret = randomBytes(32).toString('base64url');
  const hash = (s: string) => createHash('sha256').update(s).digest('base64url');
  return { verifier, pollSecret, challenge: hash(verifier), state: hash(pollSecret) };
}
export async function loginSso(client: CindyAuthClient, connectionId: string, signal: AbortSignal,
  open: (url: string) => Promise<void>): Promise<LoginOutcome> {
  const deadline = AbortSignal.timeout(5 * 60_000), combined = AbortSignal.any([signal, deadline]);
  const check = () => { if (combined.aborted) throw Error(signal.aborted ? '登录已取消' : '登录已超时，请重新登录'); };
  const proof = createProof();
  check();
  const url = client.buildAuthorizeUrl({ kind: 'sso', providerOrConnectionId: connectionId,
    redirectUri: endpoints.authDesktopCallbackUrl, codeChallenge: proof.challenge, state: proof.state });
  await open(url); // macOS openExternal resolves when dispatched, not when the browser closes.
  let failures = 0;
  for (;;) {
    check();
    try {
      const result = await client.pollDesktopAuthorization(proof.pollSecret, { signal: combined });
      check(); failures = 0;
      if (result.status === 'ok') {
        const outcome = await client.exchangeAuthorizationCode(result.code, proof.verifier);
        check(); return outcome;
      }
      if (result.status === 'error' || result.status === 'expired') throw Error('企业授权未完成，请重新登录');
    } catch (error) {
      check();
      if (error instanceof Error && error.message === '企业授权未完成，请重新登录') throw error;
      if (++failures >= 3) throw Error('SSO 连接中断，请重新登录');
    }
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); combined.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, 1000);
      combined.addEventListener('abort', finish, { once: true });
      if (combined.aborted) finish();
    });
  }
}
