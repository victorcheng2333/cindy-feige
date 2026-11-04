import ExpoModulesCore
import UIKit

public final class CindyJPushModule: Module {
  private static var started = false
  private static var deviceToken: Data?
  private static var gateURL: URL? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "ExpoShareIntoAppGroupId") as? String else { return nil }
    return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?
      .appendingPathComponent("jpush-display-gate.json")
  }

  static func receiveToken(_ token: Data) {
    deviceToken = token
    if started { CindyJPushSDK.registerToken(token) }
  }

  public func definition() -> ModuleDefinition {
    Name("CindyJPush")
    Function("setGate") { (alias: String, preview: Bool) -> Bool in
      guard let url = Self.gateURL else { return false }
      do {
        if alias.isEmpty {
          if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
          return true
        }
        let data = try JSONSerialization.data(withJSONObject: ["alias": alias, "preview": preview])
        try data.write(to: url, options: .atomic)
        return true
      } catch { return false }
    }
    Function("accepts") { (alias: String) -> Bool in
      guard let url = Self.gateURL, let data = try? Data(contentsOf: url),
        let gate = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
      return !alias.isEmpty && gate["alias"] as? String == alias
    }
    Function("config") { () -> [String: Any]? in
      guard let key = Bundle.main.object(forInfoDictionaryKey: "CindyJPushAppKey") as? String,
        !key.isEmpty else { return nil }
      return ["appKey": key,
        "production": Bundle.main.object(forInfoDictionaryKey: "CindyJPushProduction") as? Bool ?? false]
    }
    AsyncFunction("bind") { (alias: String, promise: Promise) in
      guard let key = Bundle.main.object(forInfoDictionaryKey: "CindyJPushAppKey") as? String,
        !key.isEmpty, alias.range(of: "^cindy_[a-f0-9]{32}$", options: .regularExpression) != nil
      else { promise.reject("JPUSH_CONFIG", "Push configuration is unavailable"); return }
      let production = Bundle.main.object(forInfoDictionaryKey: "CindyJPushProduction") as? Bool ?? false
      CindyJPushSDK.start(key, production: production)
      Self.started = true
      if let token = Self.deviceToken { CindyJPushSDK.registerToken(token) }
      UIApplication.shared.registerForRemoteNotifications()
      CindyJPushSDK.bindAlias(alias) { code in
        if code == 0 { promise.resolve(nil) }
        else { promise.reject("JPUSH_BIND", "Push registration failed (\(code))") }
      }
    }.runOnQueue(.main)
    AsyncFunction("disable") { (promise: Promise) in
      if !Self.started {
        guard let key = Bundle.main.object(forInfoDictionaryKey: "CindyJPushAppKey") as? String,
          !key.isEmpty else { promise.resolve(nil); return }
        CindyJPushSDK.start(key, production: Bundle.main.object(forInfoDictionaryKey: "CindyJPushProduction") as? Bool ?? false)
        Self.started = true
      }
      CindyJPushSDK.disable { code in
        if code == 0 { promise.resolve(nil) }
        else { promise.reject("JPUSH_DISABLE", "Push unregistration failed (\(code))") }
      }
    }.runOnQueue(.main)
  }
}

public final class CindyJPushAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(_ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    CindyJPushModule.receiveToken(deviceToken)
  }
}
