// Unit: production loginSso owns PKCE exchange and cancellation. A browser result
// outlives the login UI; existing device tests cannot catch a cancelled exchange.
import { afterEach, expect, it, vi } from "vitest";
vi.mock("expo-crypto", () => ({}));
vi.mock("expo-web-browser", () => ({}));
import { loginSso, type SsoHost } from "./sso";
import { CindyAuthClient } from "../../../packages/auth-client/src/index";
const proof = {
  verifier: "private-verifier",
  pollSecret: "private-poll-secret",
  challenge: "public-challenge",
  state: "public-state",
};
const setup = () => {
  const client = new CindyAuthClient({
    baseUrl: "https://auth.example.test",
    region: "cn",
    deviceId: "phone",
    clientType: "mobile",
    fetch: vi.fn(),
  });
  const poll = vi
    .spyOn(client, "pollDesktopAuthorization")
    .mockResolvedValue({ status: "ok", code: "one-time-code" });
  const exchange = vi
    .spyOn(client, "exchangeAuthorizationCode")
    .mockResolvedValue({
      status: "select_account",
      loginTicket: "ticket",
      accounts: [],
    } as any);
  let url = "";
  const host: SsoHost = {
    proof: async () => proof,
    open: (value) => {
      url = value;
      return new Promise(() => {});
    },
    close: vi.fn(),
  };
  return {
    client,
    poll,
    exchange,
    host,
    url: () => url,
    abort: new AbortController(),
  };
};
afterEach(() => vi.useRealTimers());
it("sends only proof digests to the browser, exchanges the code once and retains account selection", async () => {
  const h = setup();
  const result = await loginSso(h.client, "xd", h.abort.signal, h.host);
  expect(h.url()).toContain("public-challenge");
  expect(h.url()).toContain("public-state");
  expect(h.url()).not.toContain("private-");
  expect(h.poll).toHaveBeenCalledWith(
    proof.pollSecret,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(h.exchange).toHaveBeenCalledWith("one-time-code", proof.verifier);
  expect(result.status).toBe("select_account");
  expect(h.host.close).toHaveBeenCalledOnce();
});
it("never exchanges a response received after user cancellation", async () => {
  const h = setup();
  h.poll.mockImplementation(async () => {
    h.abort.abort();
    return { status: "ok", code: "late" };
  });
  await expect(
    loginSso(h.client, "xd", h.abort.signal, h.host),
  ).rejects.toThrow("取消");
  expect(h.exchange).not.toHaveBeenCalled();
});
it("rejects credentials that arrive after cancellation during exchange", async () => {
  const h = setup();
  h.exchange.mockImplementation(async () => {
    h.abort.abort();
    return { status: "ok" } as any;
  });
  await expect(
    loginSso(h.client, "xd", h.abort.signal, h.host),
  ).rejects.toThrow("取消");
});
it.each(["expired", "error"] as const)(
  "does not exchange a %s authorization",
  async (status) => {
    const h = setup();
    h.poll.mockResolvedValue(
      status === "error" ? { status, error: "DENIED" } : { status },
    );
    await expect(
      loginSso(h.client, "xd", h.abort.signal, h.host),
    ).rejects.toThrow();
    expect(h.exchange).not.toHaveBeenCalled();
  },
);
it("stops after the overall deadline and closes the browser", async () => {
  vi.useFakeTimers();
  const h = setup();
  h.poll.mockResolvedValue({ status: "pending" });
  const promise = loginSso(h.client, "xd", h.abort.signal, h.host);
  const rejected = expect(promise).rejects.toThrow("超时");
  await vi.advanceTimersByTimeAsync(300001);
  await rejected;
  expect(h.host.close).toHaveBeenCalledOnce();
  expect(h.exchange).not.toHaveBeenCalled();
});
