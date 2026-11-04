const { withInfoPlist, withEntitlementsPlist } = require('@expo/config-plugins');

module.exports = function withJPush(config, { appKey, environment }) {
  if (!/^[a-f0-9]{24}$/.test(appKey ?? '') || !['sandbox', 'production'].includes(environment)) {
    throw new Error('JPush requires an AppKey and explicit sandbox/production APNs environment');
  }
  const group = `group.${config.ios.bundleIdentifier}`;
  config.ios = { ...config.ios, infoPlist: { ...config.ios.infoPlist, CindyJPushAppGroup: group, ExpoShareIntoAppGroupId: group } };
  const extensions = config.extra?.eas?.build?.experimental?.ios?.appExtensions;
  if (extensions) for (const extension of extensions) {
    if (extension.targetName === 'CindyNotificationService') {
      extension.entitlements = { ...extension.entitlements, 'com.apple.security.application-groups': [group] };
    }
  }
  config = withInfoPlist(config, mod => {
    mod.modResults.CindyJPushAppKey = appKey;
    mod.modResults.CindyJPushProduction = environment === 'production';
    return mod;
  });
  return withEntitlementsPlist(config, mod => {
    mod.modResults['com.apple.security.application-groups'] = [...new Set([...(mod.modResults['com.apple.security.application-groups'] ?? []), group])];
    mod.modResults['aps-environment'] = environment === 'sandbox' ? 'development' : 'production';
    return mod;
  });
};
