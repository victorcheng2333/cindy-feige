import { ComposerNativeSection as Section } from './ComposerNativeSection';
import { RNHostView, Text } from '@expo/ui/swift-ui';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ComposerNativeRow } from './ComposerNativeRow';
import type { ModelPickerNativeHeaderProps } from './ModelPickerNativeHeader';
export function ModelPickerNativeHeader(p: ModelPickerNativeHeaderProps) {
  const { t } = useTranslation();
  return <>
    {p.agentContent ? <Section><RNHostView matchContents><View>{p.agentContent}</View></RNHostView></Section> : null}
    {p.onPermission ? <Section><ComposerNativeRow title={t('models.picker.permissionTitle')}
      subtitle={p.permissionLabel} disabled={p.permissionDisabled} onPress={p.onPermission}
      testID={`${p.testID}.permissionTrigger`} /></Section> : null}
    {p.noResults ? <Section><Text>{t('models.picker.noResults')}</Text></Section> : null}
  </>;
}
