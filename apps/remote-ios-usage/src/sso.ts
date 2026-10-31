import * as Crypto from "expo-crypto";
import * as WebBrowser from "expo-web-browser";
import type {
  CindyAuthClient,
  LoginOutcome,
} from "../../../packages/auth-client/src/index";
import endpoints from "../../../config/endpoint.json";
const urlSafe = (s: string) =>
  s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const digest = async (s: string) =>
  urlSafe(
    await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, s, {
      encoding: Crypto.CryptoEncoding.BASE64,
    }),
  );
export async function createSsoProof() {
  // Independent random secrets; only their SHA-256 digests enter the browser URL.
  const verifier = Crypto.randomUUID() + Crypto.randomUUID();
  const pollSecret = Crypto.randomUUID() + Crypto.randomUUID();
  return {
    verifier,
    pollSecret,
    challenge: await digest(verifier),
    state: await digest(pollSecret),
  };
}
export interface SsoHost {
  proof: typeof createSsoProof;
  open(url: string): Promise<unknown>;
  close(): void;
}
const nativeHost: SsoHost = {
  proof: createSsoProof,
  open: (url) => WebBrowser.openBrowserAsync(url),
  close: () => {
    WebBrowser.dismissBrowser();
  },
};
/** Existing hosted callback protocol: no new redirect scheme or server allowlist. */
export async function loginSso(
  client: CindyAuthClient,
  connectionId: string,
  signal: AbortSignal,
  host: SsoHost = nativeHost,
): Promise<LoginOutcome> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
  }, 5 * 60_000);
  const check = () => {
    if (signal.aborted || controller.signal.aborted)
      throw Error(timedOut ? "SSO 登录超时，请重试" : "已取消 SSO 登录");
  };
  let browserError = false,
    opened = false,
    complete = false;
  const delay = () =>
    new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(t);
        controller.signal.removeEventListener("abort", finish);
        resolve();
      };
      const t = setTimeout(finish, 1000);
      controller.signal.addEventListener("abort", finish, { once: true });
      if (controller.signal.aborted) finish();
    });
  try {
    check();
    const proof = await host.proof();
    check();
    const url = client.buildAuthorizeUrl({
      kind: "sso",
      providerOrConnectionId: connectionId,
      redirectUri: endpoints.authDesktopCallbackUrl,
      codeChallenge: proof.challenge,
      state: proof.state,
    });
    opened = true;
    void host.open(url).then(
      () => {
        if (!complete) cancel();
      },
      () => {
        browserError = true;
        cancel();
      },
    );
    let failures = 0;
    for (;;) {
      check();
      let result;
      try {
        result = await client.pollDesktopAuthorization(proof.pollSecret, {
          signal: controller.signal,
        });
        failures = 0;
      } catch {
        if (browserError) throw Error("无法打开 SSO 登录页面");
        check();
        if (++failures >= 3) throw Error("SSO 连接中断，请重新登录");
        await delay();
        continue;
      }
      check();
      if (result.status === "ok") {
        const outcome = await client.exchangeAuthorizationCode(
          result.code,
          proof.verifier,
        );
        check();
        complete = true;
        return outcome;
      }
      if (result.status === "error") throw Error("企业授权未完成，请重新登录");
      if (result.status === "expired")
        throw Error("SSO 授权已过期，请重新登录");
      await delay();
    }
  } finally {
    complete = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    controller.abort();
    if (opened)
      try {
        host.close();
      } catch {
        /* Browser may already have been closed by the user. */
      }
  }
}
