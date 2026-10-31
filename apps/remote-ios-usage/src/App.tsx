import React, { useEffect, useRef, useState } from "react";
import {
  AppState,
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { Remote, type Account, type Device, type Quota } from "./remote";
import { loginSso } from "./sso";
import { EdgeBackGesture } from "./EdgeBackGesture";
import type { SsoOrgDiscovery } from "../../../packages/auth-client/src/index";
import type { LoginOutcome } from "../../../packages/auth-client/src/index";
const demoDevice: Device = {
  deviceId: "demo",
  name: "我的 MacBook",
  online: true,
  remoteControlEnabled: true,
  platform: "darwin",
};
const demoAccounts: Account[] = [
  {
    id: "a",
    service: "Claude",
    name: "Claude 工作账号",
    plan: "Max",
    windows: [
      { minutes: 300, left: 68, reset: Date.now() / 1000 + 7200 },
      { minutes: 10080, left: 42, reset: Date.now() / 1000 + 172800 },
    ],
    updated: Date.now(),
    failed: false,
  },
  {
    id: "b",
    service: "ChatGPT",
    name: "OpenAI 个人账号",
    plan: "Pro",
    windows: [
      { minutes: 300, left: 22, reset: Date.now() / 1000 + 10800 },
      { minutes: 10080, left: 76, reset: Date.now() / 1000 + 259200 },
    ],
    updated: Date.now(),
    failed: false,
  },
];
export default function App() {
  return (
    <SafeAreaProvider>
      <UsageApp />
    </SafeAreaProvider>
  );
}
function UsageApp() {
  const dark = useColorScheme() === "dark";
  const c = dark
    ? {
        bg: "#121212",
        card: "#1e1e1e",
        text: "#ededed",
        muted: "#bdbdbd",
        line: "#383838",
        track: "#303030",
        accent: "#d97757",
      }
    : {
        bg: "#f9f9f6",
        card: "#fffffc",
        text: "#0f0f0f",
        muted: "#5e5d59",
        line: "#d9d8d0",
        track: "#e8e6dc",
        accent: "#a8472a",
      };
  const [remote, setRemote] = useState<Remote | null>(null),
    [signed, setSigned] = useState(false),
    [demo, setDemo] = useState(false),
    [devices, setDevices] = useState<Device[]>([]),
    [device, setDevice] = useState<Device | null>(null),
    [accounts, setAccounts] = useState<Account[]>([]),
    [selected, setSelected] = useState<Account | null>(null),
    [identifier, setIdentifier] = useState(""),
    [code, setCode] = useState(""),
    [sent, setSent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [outcome, setOutcome] = useState<LoginOutcome | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [restoreHint, setRestoreHint] = useState("正在恢复登录");
  const [restoreNotice, setRestoreNotice] = useState("");
  const [org, setOrg] = useState("xd");
  const [ssoChoices, setSsoChoices] = useState<SsoOrgDiscovery | null>(null);
  const ssoAbort = useRef<AbortController | null>(null);
  useEffect(() => () => ssoAbort.current?.abort(), []);
  const epoch = useRef(0),
    reading = useRef<number | null>(null),
    cooldown = useRef(0);
  useEffect(() => {
    let live = true;
    void Remote.create()
      .then(async (r) => {
        let list: Device[] = [], target: Device | null = null, warning = "";
        if (!live) { r.disconnect(); return; }
        if (r.tokens) {
          try {
            const lastDeviceId = await r.readLastDevice();
            if (!live) { r.disconnect(); return; }
            if (lastDeviceId) {
              setRestoreHint("正在恢复上次查看的电脑");
              list = await r.devices();
              target = list.find(d => d.deviceId === lastDeviceId && d.online && d.remoteControlEnabled) ?? null;
              if (!target) warning = "上次查看的电脑当前不可用，请从列表选择。";
            }
          } catch {
            warning = "暂时无法恢复上次查看的电脑，已回到设备首页。";
          }
        }
        if (live) {
          setRemote(r);
          setSigned(!!r.tokens);
          setDevices(r.tokens ? list : []);
          setDevice(r.tokens ? target : null);
          setRestoreNotice(warning);
          setRestoring(false);
        } else r.disconnect();
      })
      .catch(() => {
        if (live) {
          setError("读取登录状态失败，请重启 App 重试");
          setRestoring(false);
        }
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => () => remote?.disconnect(), [remote]);
  const run = async (fn: () => Promise<void>) => {
    const g = epoch.current;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (g === epoch.current) {
        setError(e instanceof Error ? e.message : "读取失败，请重试");
        if (signed && remote && !remote.tokens) {
          setSigned(false);
          setDevices([]);
          setDevice(null);
          setAccounts([]);
          setSelected(null);
        }
      }
    } finally {
      if (g === epoch.current) setBusy(false);
    }
  };
  const accept = async (o: LoginOutcome) => {
    if (o.status === "ok") {
      await remote!.saveSession(o);
      setOutcome(null);
      setCode("");
      setSigned(true);
      setDevices(await remote!.devices());
    } else if (
      o.status === "select_account" ||
      o.status === "sso_verification_required"
    )
      setOutcome(o);
    else
      throw Error(
        "此账号需要额外验证，当前版本暂不支持，请使用已绑定的手机号或邮箱。",
      );
  };
  const startSso = async (connectionId: string) => {
    if (!remote) throw Error("正在初始化，请稍后");
    ssoAbort.current?.abort();
    const abort = new AbortController();
    ssoAbort.current = abort;
    const generation = epoch.current;
    try {
      const result = await loginSso(remote.auth, connectionId, abort.signal);
      if (!abort.signal.aborted && generation === epoch.current)
        await accept(result);
    } finally {
      if (ssoAbort.current === abort) ssoAbort.current = null;
    }
  };
  const refresh = async () => {
    const g = epoch.current;
    if (reading.current === g || demo || !remote) return;
    reading.current = g;
    try {
      await run(async () => {
        if (device) {
          const data = await remote.usage(device.deviceId);
          if (g === epoch.current) setAccounts(data);
        } else {
          const list = await remote.devices();
          if (g === epoch.current) setDevices(list);
        }
      });
    } finally {
      if (reading.current === g) reading.current = null;
    }
  };
  useEffect(() => {
    if (!signed || demo) return;
    void refresh();
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void refresh();
    }, 30000);
    return () => clearInterval(timer);
  }, [device, demo, remote, signed]);
  const clearLoginView = () => {
    setSigned(false);
    setDemo(false);
    setDevice(null);
    setSelected(null);
    setDevices([]);
    setAccounts([]);
    setOutcome(null);
    setSent(false);
    setCode("");
    setRestoreNotice("");
  };
  const logout = () => {
    epoch.current++;
    ssoAbort.current?.abort();
    void run(async () => {
      await remote?.logout();
      clearLoginView();
    });
  };
  const navigateToDevice = async (next: Device | null) => {
    const g = ++epoch.current;
    setBusy(true);
    setError("");
    setRestoreNotice("");
    try {
      if (!demo) {
        if (!remote) throw Error("正在初始化，请稍后");
        await remote.rememberDevice(next?.deviceId ?? null);
      }
      if (g !== epoch.current) return;
      setSelected(null);
      setAccounts(demo && next ? demoAccounts : []);
      setDevice(next);
    } catch {
      if (g === epoch.current) setError("无法保存上次查看的设备，请重试。");
    } finally {
      if (g === epoch.current) setBusy(false);
    }
  };
  const leave = () => {
    if (device && !selected) { void navigateToDevice(null); return; }
    epoch.current++;
    setBusy(false);
    setError("");
    if (selected) setSelected(null);
    else if (demo) clearLoginView();
  };
  const label = (q: Pick<Quota, "minutes" | "label">) =>
    `${q.label ? q.label + " · " : ""}${q.minutes === 10080 ? "7 天" : q.minutes === null ? "周期未知" : q.minutes % 60 === 0 ? `${q.minutes / 60} 小时` : `${q.minutes} 分钟`}`;
  const valid = (q?: Quota) => q && (!q.reset || q.reset * 1000 > Date.now());
  const txt = (s: string, style: any = {}) => (
    <Text style={[{ color: c.text, fontSize: 16, lineHeight: 24 }, style]}>
      {s}
    </Text>
  );
  const button = (title: string, onPress: () => void, primary = false) => (
    <Pressable
      accessibilityRole="button"
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: primary ? c.text : c.card,
          borderColor: c.line,
          opacity: pressed || busy ? 0.5 : 1,
        },
      ]}
    >
      {txt(title, { color: primary ? c.bg : c.text, fontWeight: "500" })}
    </Pressable>
  );
  const current = selected ? accounts.find((a) => a.id === selected.id) : null;
  const quota = (minutes: number, a: Account) => {
    const q = a.windows.find((w) => w.minutes === minutes && !w.label);
    return (
      <View key={minutes} style={{ flex: 1, gap: 12 }}>
        {txt(label({ minutes }), { color: c.muted, fontSize: 13 })}
        <View style={{ flexDirection: "row", alignItems: "baseline" }}>
          {txt(valid(q) ? Math.round(q!.left).toString() : "—", {
            fontSize: 36,
            lineHeight: 44,
            fontWeight: "500",
            fontVariant: ["tabular-nums"],
          })}
          {valid(q) ? txt("%", { color: c.muted, fontSize: 16 }) : null}
        </View>
        <View
          style={{
            height: 5,
            borderRadius: 8,
            backgroundColor: c.track,
            overflow: "hidden",
          }}
        >
          {valid(q) ? (
            <View
              style={{
                height: 5,
                width: `${q!.left}%`,
                backgroundColor: q!.left <= 25 ? c.accent : c.muted,
              }}
            />
          ) : null}
        </View>
        {txt("剩余配额", { fontSize: 12, color: c.muted })}
      </View>
    );
  };
  if (restoring)
    return (
      <SafeAreaView
        style={{
          flex: 1,
          backgroundColor: c.bg,
          justifyContent: "center",
          alignItems: "center",
          gap: 16,
        }}
      >
        <ActivityIndicator color={c.muted} />
        {txt(restoreHint, { color: c.muted })}
      </SafeAreaView>
    );
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
      <EdgeBackGesture
        enabled={!!device}
        routeKey={`${device?.deviceId ?? "home"}:${selected?.id ?? "list"}`}
        onBack={leave}
      >
        <ScrollView
          contentContainerStyle={styles.page}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.nav}>
            {device || selected
              ? button("‹ 返回", leave)
              : demo
                ? button("退出演示", leave)
                : !signed
                  ? txt("猫猫", { fontWeight: "600" })
                  : null}
            {signed && !demo && !device && !selected
              ? button("退出登录", logout)
              : null}
            {signed || demo
              ? button("刷新", () => void refresh())
              : txt("中国大陆", { fontSize: 12, color: c.muted })}
          </View>
          {demo
            ? txt("演示模式 · 以下数据为虚构", {
                fontSize: 13,
                color: c.accent,
              })
            : null}
          {txt(
            !signed && !demo
              ? "用量，一目了然。"
              : current
                ? current.name
                : device
                  ? device.name
                  : "你的电脑",
            { fontSize: 28, lineHeight: 36, fontWeight: "600" },
          )}
          {txt(
            !signed && !demo
              ? "连接 Cindy，在手机查看订阅的剩余配额。"
              : device
                ? "5 小时与周配额，放在一起看。"
                : "选择一台电脑，查看它连接的订阅账号。",
            { fontSize: 15, color: c.muted },
          )}
          {error || restoreNotice ? txt(error || restoreNotice, { fontSize: 13, color: c.accent }) : null}
          {busy ? <ActivityIndicator color={c.muted} /> : null}
          {!signed && !demo ? (
            <View style={{ gap: 14, marginTop: 18 }}>
              {!outcome ? (
                <>
                  {txt("企业 SSO", { fontWeight: "500" })}
                  <TextInput
                    accessibilityLabel="企业标识"
                    placeholder="企业标识或域名"
                    placeholderTextColor={c.muted}
                    editable={!busy}
                    autoCapitalize="none"
                    autoCorrect={false}
                    value={org}
                    onChangeText={(value) => {
                      setOrg(value);
                      setSsoChoices(null);
                    }}
                    style={[
                      styles.input,
                      {
                        color: c.text,
                        borderColor: c.line,
                        backgroundColor: c.card,
                      },
                    ]}
                  />
                  {button(
                    "使用企业 SSO 登录",
                    () =>
                      void run(async () => {
                        if (!remote) throw Error("正在初始化，请稍后");
                        if (!org.trim()) throw Error("请输入企业标识");
                        const discovery = await remote.auth.discoverSsoOrg(
                          org.trim(),
                        );
                        if (discovery.connections.length === 1)
                          await startSso(discovery.connections[0].connectionId);
                        else setSsoChoices(discovery);
                      }),
                    true,
                  )}
                  {ssoChoices?.connections.map((connection) => (
                    <View key={connection.connectionId}>
                      {button(
                        connection.connectionName,
                        () => void run(() => startSso(connection.connectionId)),
                      )}
                    </View>
                  ))}
                  {busy ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => ssoAbort.current?.abort()}
                      style={styles.button}
                    >
                      {txt("取消 SSO 登录")}
                    </Pressable>
                  ) : null}
                  {txt("或使用手机号 / 邮箱", { color: c.muted, fontSize: 13 })}
                </>
              ) : null}
              {outcome?.status === "sso_verification_required" ? (
                <>
                  {txt(`请输入发送到 ${outcome.targetMasked} 的验证码`)}
                  <TextInput
                    accessibilityLabel="SSO 验证码"
                    value={code}
                    onChangeText={setCode}
                    keyboardType="number-pad"
                    style={[
                      styles.input,
                      {
                        color: c.text,
                        borderColor: c.line,
                        backgroundColor: c.card,
                      },
                    ]}
                  />
                  {button(
                    "获取验证码",
                    () =>
                      void run(() =>
                        remote!.auth.requestSsoVerificationCode(
                          outcome.verificationTicket,
                        ),
                      ),
                  )}
                  {button(
                    "完成验证",
                    () =>
                      void run(async () =>
                        accept(
                          await remote!.auth.verifySsoVerification(
                            outcome.verificationTicket,
                            code.trim(),
                          ),
                        ),
                      ),
                    true,
                  )}
                </>
              ) : null}

              {outcome?.status === "select_account" ? (
                outcome.accounts.map((a) =>
                  button(
                    a.displayName || a.id,
                    () =>
                      void run(() =>
                        remote!.auth
                          .selectAccount(outcome.loginTicket, a.id)
                          .then(accept),
                      ),
                  ),
                )
              ) : outcome?.status === "sso_verification_required" ? null : (
                <>
                  <TextInput
                    accessibilityLabel="手机号或邮箱"
                    placeholder="手机号或邮箱"
                    placeholderTextColor={c.muted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    value={identifier}
                    onChangeText={(v) => {
                      setIdentifier(v);
                      setSent(false);
                      setCode("");
                    }}
                    style={[
                      styles.input,
                      {
                        color: c.text,
                        borderColor: c.line,
                        backgroundColor: c.card,
                      },
                    ]}
                  />
                  {sent ? (
                    <TextInput
                      accessibilityLabel="验证码"
                      placeholder="验证码"
                      placeholderTextColor={c.muted}
                      value={code}
                      onChangeText={setCode}
                      keyboardType="number-pad"
                      textContentType="oneTimeCode"
                      style={[
                        styles.input,
                        {
                          color: c.text,
                          borderColor: c.line,
                          backgroundColor: c.card,
                        },
                      ]}
                    />
                  ) : null}
                  {button(
                    sent ? "登录并连接" : "获取验证码",
                    () =>
                      void run(async () => {
                        if (!remote) throw Error("正在初始化，请稍后");
                        const value = identifier.trim();
                        if (!value) throw Error("请输入手机号或邮箱");
                        const kind = value.includes("@") ? "email" : "phone";
                        if (sent) {
                          await accept(
                            await remote.auth.verifyCode(
                              kind,
                              value,
                              code.trim(),
                            ),
                          );
                        } else {
                          if (Date.now() < cooldown.current)
                            throw Error("请稍后再获取验证码");
                          await remote.auth.requestCode(kind, value);
                          cooldown.current = Date.now() + 60000;
                          setSent(true);
                        }
                      }),
                    true,
                  )}
                </>
              )}
              {button("先看看界面", () => {
                setDemo(true);
                setDevices([
                  demoDevice,
                  {
                    ...demoDevice,
                    deviceId: "offline-demo",
                    name: "办公室 Mac",
                    online: false,
                  },
                ]);
                setError("");
              })}
              {txt(
                "订阅凭证留在电脑。登录状态保存在 iOS 钥匙串中，下次打开自动恢复。",
                { fontSize: 13, color: c.muted },
              )}
            </View>
          ) : !device ? (
            <View style={{ gap: 12, marginTop: 12 }}>
              {devices.map((d) => (
                <Pressable
                  key={d.deviceId}
                  accessibilityRole="button"
                  disabled={!d.online || !d.remoteControlEnabled}
                  accessibilityState={{
                    disabled: !d.online || !d.remoteControlEnabled,
                  }}
                  onPress={() => void navigateToDevice(d)}
                  style={[
                    styles.card,
                    {
                      backgroundColor: d.online ? c.card : c.track,
                      borderColor: c.line,
                    },
                  ]}
                >
                  <View style={styles.nav}>
                    {txt(d.name, {
                      fontWeight: d.online ? "500" : "400",
                      fontSize: 18,
                      color: d.online ? c.text : c.muted,
                    })}
                    {txt("›", { color: c.muted, fontSize: 26 })}
                  </View>
                  {txt(
                    !d.online
                      ? "离线"
                      : !d.remoteControlEnabled
                        ? "尚未允许远程连接"
                        : "在线 · 可查看",
                    { color: c.muted, fontSize: 13 },
                  )}
                </Pressable>
              ))}
              {!busy && !devices.length
                ? txt(
                    "还没有可显示的电脑。请在电脑端登录同一账号并开启远程连接。",
                    { color: c.muted },
                  )
                : null}
            </View>
          ) : current ? (
            <View style={{ gap: 14 }}>
              <View
                style={[
                  styles.card,
                  { backgroundColor: c.card, borderColor: c.line },
                ]}
              >
                <View style={{ flexDirection: "row", gap: 30 }}>
                  {quota(300, current)}
                  {quota(10080, current)}
                </View>
              </View>
              {current.windows.map((q, i) => (
                <View
                  key={i}
                  style={[
                    styles.card,
                    { backgroundColor: c.card, borderColor: c.line },
                  ]}
                >
                  {txt(label(q), { fontWeight: "500" })}
                  {txt(
                    valid(q) ? `剩余 ${Math.round(q.left)}%` : "等待新配额",
                    {
                      fontSize: 22,
                      lineHeight: 30,
                    },
                  )}
                  {txt(
                    q.reset
                      ? `${new Date(q.reset * 1000).toLocaleString()} 重置`
                      : "重置时间未知",
                    { color: c.muted, fontSize: 13 },
                  )}
                </View>
              ))}
            </View>
          ) : (
            <View style={{ gap: 14, marginTop: 12 }}>
              {accounts.map((a) => (
                <Pressable
                  key={a.id}
                  accessibilityRole="button"
                  onPress={() => setSelected(a)}
                  style={[
                    styles.card,
                    { backgroundColor: c.card, borderColor: c.line },
                  ]}
                >
                  <View style={styles.nav}>
                    {txt(a.name, { fontSize: 18, fontWeight: "500" })}
                    {txt(`${a.service}${a.plan ? " · " + a.plan : ""}`, {
                      fontSize: 13,
                      color: c.muted,
                    })}
                  </View>
                  <View
                    style={{
                      flexDirection: "row",
                      gap: 30,
                      marginVertical: 16,
                    }}
                  >
                    {quota(300, a)}
                    {quota(10080, a)}
                  </View>
                  {txt(
                    a.failed
                      ? "暂未获取用量"
                      : a.updated
                        ? `更新于 ${new Date(a.updated).toLocaleTimeString()}  ›`
                        : "更新时间未知  ›",
                    { fontSize: 12, color: c.muted },
                  )}
                </Pressable>
              ))}
              {!busy && !accounts.length
                ? txt("暂无 Claude / ChatGPT 订阅账号，或尚未读取到数据。", {
                    color: c.muted,
                  })
                : null}
              {txt("同一订阅账号在多台电脑共享配额，不应相加。", {
                fontSize: 13,
                color: c.muted,
              })}
            </View>
          )}
        </ScrollView>
      </EdgeBackGesture>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  page: {
    padding: 24,
    gap: 16,
    paddingBottom: 48,
    maxWidth: 620,
    width: "100%",
    alignSelf: "center",
  },
  nav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  card: { borderWidth: 1, borderRadius: 12, padding: 20, gap: 8 },
  button: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 10,
    alignItems: "center",
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 16,
    fontSize: 16,
    lineHeight: 22,
    minHeight: 52,
  },
});
