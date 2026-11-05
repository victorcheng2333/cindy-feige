import { NativeErrorNotice } from "@/components/NativeErrorNotice.ios";
import { ModelSpeedIcon } from "./ModelSpeedIcon";
import { ModelQuotaBar } from "./ModelQuotaBar";
import {
  Button,
  HStack,
  Picker,
  RNHostView,
  VStack,
  Text,
} from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  buttonStyle,
  disabled,
  font,
  foregroundStyle,
  frame,
  pickerStyle,
  tint,
  tag,
  padding,
  lineLimit,
} from "@expo/ui/swift-ui/modifiers";
import {
  Check,
  SlidersHorizontal,
  X,
  LayoutGrid,
} from "lucide-react-native";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { iconSize, useTheme } from "@/theme";
import { ComposerSheet } from "./ComposerSheet";
import { ComposerNativeSection as Section } from "./ComposerNativeSection";
import { ComposerNativeRow } from "./ComposerNativeRow";
import { MobileModelIconMark, MobileProviderMark } from "./MobileProviderMark";
import { groupSourceFilters } from "./remoteSourceFilters";
import { mobileAgentLabel } from "./sessionAgentSwitch";
import type { UnifiedMobilePickerViewProps } from "./UnifiedModelPickerSheet";

function NativeMark({ children }: { children: ReactNode }) {
  return (
    <RNHostView matchContents>
      <View
        pointerEvents="none"
        style={{
          width: 24,
          height: 24,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {children}
      </View>
    </RNHostView>
  );
}

/** 来源格的供应商 mark;另一台电脑上的供应商带远程标记(右上角一道波纹加一个点)。 */
function ProviderSourceMark({
  filter,
}: {
  filter: UnifiedMobilePickerViewProps["filters"][number] | undefined;
}) {
  return (
    <MobileProviderMark
      {...filter?.providerMark}
      name={filter?.providerMark?.name ?? ""}
      remote={filter?.remote != null}
    />
  );
}

export function UnifiedModelPickerView(p: UnifiedMobilePickerViewProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [page, setPage] = useState<"sources" | null>(null);
  useEffect(() => {
    setPage(null);
  }, [p.visible, p.options?.row.key]);
  const mark = (Icon: typeof Check, filled = false) => (
    <NativeMark>
      <Icon
        size={iconSize.action}
        color={colors.textSecondary}
        fill={filled ? colors.textSecondary : "none"}
      />
    </NativeMark>
  );
  const options = p.options;
  const config = options?.row.config;
  const level = (id: string) =>
    t(`models.options.effortLevels.${id}`, { defaultValue: id });
  const listHeader = (
    <VStack spacing={8} modifiers={[padding({ horizontal: 20, bottom: 8 })]}>
      {(p.agents?.length ?? 0) > 0 ? (
        <Picker
          label={t("models.unified.harness")}
          selection={p.browsingAgent}
          onSelectionChange={(agent: string) => { void p.onBrowseAgent(agent as typeof p.browsingAgent); }}
          modifiers={[pickerStyle("segmented"), disabled(p.busy), frame({ minHeight: 44 })]}
          testID={`${p.testID}.agentSwitcher`}
        >
          {p.agents.map(agent => <Text key={agent} modifiers={[tag(agent)]}>{mobileAgentLabel(agent)}</Text>)}
        </Picker>
      ) : null}
      <HStack modifiers={[frame({ maxWidth: Infinity, alignment: "trailing" })]}>
      <Button
        onPress={() => setPage("sources")}
        modifiers={[
          buttonStyle("plain"),
          frame({ maxWidth: 120, minHeight: 44 }),
          accessibilityLabel(t("models.unified.source")),
        ]}
        testID={`${p.testID}.filter`}
      >
        <HStack>
          {p.filter === "all" ? (
            mark(LayoutGrid)
          ) : (
            <NativeMark>
              <ProviderSourceMark
                filter={p.filters.find((item) => item.id === p.filter)}
              />
            </NativeMark>
          )}
          <Text modifiers={[lineLimit(1)]}>
            {p.filters.find((item) => item.id === p.filter)?.label}
          </Text>
        </HStack>
      </Button>
      </HStack>
    </VStack>
  );
  const listContent = (
    <>
      {p.error ? (
        <Section>
          <NativeErrorNotice message={p.error} />
        </Section>
      ) : null}
      {p.groups.map((group) => (
        <Section key={group.key} title={group.title}>
          {group.quota ? <HStack spacing={8}>
            <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(colors.textSecondary)]}>{group.quota.label}</Text>
            <RNHostView matchContents><ModelQuotaBar remaining={group.quota.remaining} label={group.quota.label} /></RNHostView>
          </HStack> : null}
          {group.rows.map((row) => (
            <ComposerNativeRow
              key={row.key}
              title={row.entry.displayName}
              subtitle={[
                mobileAgentLabel(row.config.agent),
                row.subtitle,
                row.quotaLabel,
              ]
                .filter(Boolean)
                .join(" · ")}
              titleAccessory={
                <HStack spacing={4}>
                  {row.costMarks ? (
                    <Text
                      modifiers={[
                        font({ textStyle: "caption" }),
                        foregroundStyle(colors.textSecondary),
                      ]}
                    >
                      {row.costMarks}
                    </Text>
                  ) : null}
                  {row.config.fast ? (
                    <NativeMark>
                      <ModelSpeedIcon
                        mode={row.config.fast}
                        color={colors.textSecondary}
                      />
                    </NativeMark>
                  ) : null}
                </HStack>
              }
              subtitleContent={
                <VStack alignment="leading" spacing={2}>
                  <Text
                    modifiers={[
                      font({ textStyle: "caption" }),
                      foregroundStyle(colors.textSecondary),
                    ]}
                  >
                    {row.subtitle}
                  </Text>
                  {row.quotaLabel ? (
                    <Text
                      modifiers={[
                        font({ textStyle: "caption2" }),
                        foregroundStyle(colors.textTertiary),
                      ]}
                    >
                      {row.quotaLabel}
                    </Text>
                  ) : null}
                </VStack>
              }
              leading={
                <RNHostView matchContents>
                  <View
                    style={{
                      width: 28,
                      height: 28,
                      justifyContent: "center",
                    }}
                  >
                    <MobileModelIconMark
                      icon={row.entry.icon}
                      {...row.providerMark}
                      color={colors.textSecondary}
                      remote={row.remoteDevice != null}
                    />
                  </View>
                </RNHostView>
              }
              optionsIcon={mark(SlidersHorizontal)}
              selectionIcon={mark(Check)}
              selected={row.selected}
              disabled={p.busy || row.disabled}
              onPress={() => p.onSelect(row)}
              onOptions={() => p.onOptions(row)}
              optionsLabel={t("models.picker.configureAccessibility", {
                model: row.entry.displayName,
              })}
              testID={`${p.testID}.model.${row.key}`}
            />
          ))}
        </Section>
      ))}
      {!p.groups.length ? (
        <Section>
          <Text modifiers={[foregroundStyle(colors.textSecondary)]}>
            {p.loading ? t("models.picker.loadingDefault") : p.emptyHint}
          </Text>
        </Section>
      ) : null}
    </>
  );
  const sourceRow = (item: (typeof p.filters)[number]) => (
    <ComposerNativeRow
      key={item.id}
      title={item.remote?.providerLabel ?? item.label}
      subtitle={item.quota?.label}
      testID={`${p.testID}.source.${item.id}`}
      selected={p.filter === item.id}
      selectionIcon={mark(Check)}
      leading={
        item.providerMark ? (
          <VStack spacing={2}>
            <NativeMark>
              <ProviderSourceMark filter={item} />
            </NativeMark>
            {item.quota ? (
              <RNHostView matchContents>
                <ModelQuotaBar
                  remaining={item.quota.remaining}
                  label={item.quota.label}
                  testID={`${p.testID}.source.${item.id}.quota`}
                />
              </RNHostView>
            ) : null}
          </VStack>
        ) : (
          mark(LayoutGrid)
        )
      }
      onPress={() => {
        p.onFilter(item.id);
        setPage(null);
      }}
    />
  );
  // 来源页分块:被控电脑自己的格一块,其他电脑每台一块。
  const sourceGroups = groupSourceFilters(p.filters);
  return (
    <ComposerSheet
      nativeContent
      largeOnly
      visible={p.visible}
      onClosed={p.onClosed}
      onClose={p.onClose}
      onBack={page ? () => setPage(null) : p.onBack}
      headerTrailing={<Button onPress={p.onClose} modifiers={[buttonStyle("plain"), accessibilityLabel(t("shared.closePanel"))]}>
        <HStack modifiers={[frame({ width: 44, height: 44 })]}>{mark(X)}</HStack>
      </Button>}
      backLabel={t("models.picker.backToModels")}
      title={
        page === "sources"
          ? t("models.unified.source")
          : p.title
      }
      testID={p.testID}
      footer={options && !options.row.selected ? (
        <Button onPress={() => options.onUse ? options.onUse() : p.onSelect(options.row)}
          modifiers={[buttonStyle("borderedProminent"), tint(colors.cta), disabled(p.busy || options.row.disabled), frame({ minHeight: 44, maxWidth: Infinity })]}
          testID={`${p.testID}.useModel`}>
          <Text modifiers={[foregroundStyle(colors.ctaText)]}>{t("models.picker.useModel")}</Text>
        </Button>
      ) : undefined}
      nativeRoot={{
        active: !options && !page,
        header: listHeader,
        content: listContent,
      }}
    >
      {p.error ? (
        <Section>
          <NativeErrorNotice message={p.error} />
        </Section>
      ) : null}
      {page === "sources" ? (
        <>
          <Section>{sourceGroups.local.map(sourceRow)}</Section>
          {/* 其他电脑的供应商:每台电脑单独一块,块标题是电脑名。 */}
          {sourceGroups.devices.map((device) => (
            <Section key={device.deviceId} title={device.name}>
              {device.filters.map(sourceRow)}
            </Section>
          ))}
        </>
      ) : options && config ? (
        <>
          <Section>
            <Text
              modifiers={[
                foregroundStyle(colors.textSecondary),
                font({ textStyle: "footnote" }),
              ]}
            >
              {options.context}
            </Text>
          </Section>
          <Section>
            {options.row.entry.capabilities[config.agent]?.efforts.length ? (
              <VStack alignment="leading" spacing={8}>
              <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(colors.textSecondary)]}>{t("models.options.reasoningEffort")}</Text>
              <Picker
                label={t("models.options.reasoningEffort")}
                selection={config.effort}
                onSelectionChange={(effort: string) =>
                  options.onChange({ ...config, effort })
                }
                modifiers={[pickerStyle("segmented"), disabled(p.busy), frame({ minHeight: 44 })]}
                testID={`${p.testID}.effort`}
              >
                {options.row.entry.capabilities[config.agent]!.efforts.map(
                  (effort) => (
                    <Text key={effort} modifiers={[tag(effort)]}>
                      {level(effort)}
                    </Text>
                  ),
                )}
              </Picker>
              </VStack>
            ) : null}
            {options.fastCapable ? (
              <VStack alignment="leading" spacing={8}>
              <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(colors.textSecondary)]}>{t("models.options.speed.label")}</Text>
              <Picker
                label={t("models.options.speed.label")}
                selection={config.fast === "ultrafast" ? "ultrafast" : config.fast ? "fast" : "standard"}
                onSelectionChange={(value: string) => options.onChange({ ...config, fast: value === "ultrafast" ? "ultrafast" : value === "fast" })}
                modifiers={[pickerStyle("segmented"), disabled(p.busy), frame({ minHeight: 44 })]}
                testID={`${p.testID}.speed`}
              >
                {(options.row.entry.capabilities[config.agent]?.supportsUltrafastMode
                  ? ["standard", "fast", "ultrafast"] : ["standard", "fast"]).map(value => (
                    <Text key={value} modifiers={[tag(value)]}>{t(`models.options.speed.${value}`)}</Text>
                  ))}
              </Picker>
              </VStack>
            ) : null}
          </Section>
          <Section>
              <Text
                testID={`${p.testID}.configState`}
                modifiers={[
                  font({ textStyle: "footnote" }),
                  foregroundStyle(colors.textSecondary),
                ]}
              >
                {t(
                  options.canReset
                    ? "models.unified.customized"
                    : "models.unified.usingRecommended",
                )}
              </Text>
              {options.canReset ? (
                <ComposerNativeRow
                  title={t("models.unified.restoreRecommended")}
                  onPress={options.onReset}
                  disabled={p.busy}
                  testID={`${p.testID}.reset`}
                />
              ) : null}
          </Section>
          {options.price ? (
            <Section>
              <Text
                modifiers={[
                  font({ textStyle: "footnote" }),
                  foregroundStyle(colors.textSecondary),
                ]}
              >
                {options.price}
              </Text>
            </Section>
          ) : null}
          {options.notice ? (
            <Section>
              <Text
                testID={`${p.testID}.notice`}
                modifiers={[
                  font({ textStyle: "footnote" }),
                  foregroundStyle(colors.textSecondary),
                ]}
              >
                {options.notice}
              </Text>
            </Section>
          ) : null}
        </>
      ) : null}
    </ComposerSheet>
  );
}
