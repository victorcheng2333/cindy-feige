#if os(macOS)
import AppKit
import ApplicationServices
import Foundation
import LocalAuthentication

/// Locked use (docs/product-rules/locked-use.md): this Mac's owner saves their own login
/// password in Settings, and Cindy may unlock this Mac for an Agent task while the privacy
/// screen covers every display. Only this signed helper reads the password; it never
/// crosses stdio, and its Keychain namespace is separate from remote desktop unlock.
@MainActor
public final class MacLockedUse {
  private let directory: URL
  private var form: CredentialPasswordForm?
  private var unlocking = false
  /// Bumped by `cancel`; an unlock started under an older value stops before its next step.
  private var generation: UInt64 = 0

  public init(directory: URL) { self.directory = directory }

  /// Fixed facts only: never the account name or anything read from the secret.
  public func status() throws -> [String: Bool] {
    let account = try MacSystemAccount.current()
    return ["saved": try vault().contains(binding: binding(account)), "accessibility": AXIsProcessTrusted()]
  }

  /// The owner, at this unlocked Mac, types the login password into a native field. It is
  /// verified by the system once before anything is saved.
  public func setup(locale: String, theme: String) async throws -> [String: Bool] {
    guard form == nil, !unlocking else { throw CredentialError.authenticationBusy }
    let account = try MacSystemAccount.current()
    guard try !MacConsoleState.read(account: account).locked else { throw CredentialError.unlockUnavailable }
    let labels = try CredentialLabels(locale: locale)
    defer { form = nil }
    let entered: (Data, Bool) = try await withCheckedThrowingContinuation { continuation in
      let form = CredentialPasswordForm(labels: labels, account: account.name, saveRequired: true) {
        continuation.resume(with: $0.mapError { $0 as Error })
      }
      self.form = form
      form.present(theme: theme)
    }
    try account.verify(entered.0)
    try vault().store(entered.0, binding: binding(account), requireBiometric: false)
    let trusted = AXIsProcessTrusted()
    if !trusted {
      // The system shows its own Accessibility prompt for this helper; nothing is granted here.
      _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary)
    }
    return ["saved": true, "accessibility": trusted]
  }

  public func forget() throws {
    form?.cancel()
    try vault().forget(binding: binding(try MacSystemAccount.current()))
  }

  /// Stops an unlock in progress before its next step (someone touched this Mac).
  public func cancel() {
    generation &+= 1
    form?.cancel()
  }

  /// Unlocks the current console session with the saved password. Main has already put
  /// the privacy screen up and checked who asked. A password the system no longer accepts
  /// is deleted instead of being typed into the lock screen, so the account is never
  /// locked out by repeated failures.
  public func unlock() async throws -> [String: Bool] {
    guard !unlocking, form == nil else { throw CredentialError.authenticationBusy }
    unlocking = true
    defer { unlocking = false }
    let started = generation
    let current: () async throws -> Void = { [weak self] in
      guard let self, self.generation == started, !Task.isCancelled else { throw CredentialError.cancelled }
    }
    let account = try MacSystemAccount.current()
    guard try MacConsoleState.read(account: account).locked else { return ["unlocked": true] }
    guard AXIsProcessTrusted() else { throw CredentialError.accessibilityRequired }
    let context = LAContext()
    context.interactionNotAllowed = true
    defer { context.invalidate() }
    let store = try vault(), key = binding(account)
    let secret = try store.read(binding: key, reason: "", context: context)
    try await current()
    do { try account.verify(secret) } catch {
      try? store.forget(binding: key)
      throw CredentialError.savedBindingChanged
    }
    try await current()
    try await MacScreenUnlocker.shared.unlock(account: account, password: secret, current: current)
    return ["unlocked": try !MacConsoleState.read(account: account).locked]
  }

  private func vault() throws -> CredentialVault {
    CredentialVault(installation: try InstallationMarker.loadOrCreate(directory: directory))
  }

  /// A fixed local namespace keyed by this OS account; not a region or account identity.
  private func binding(_ account: MacSystemAccount) -> CredentialBinding {
    CredentialBinding(realm: .global, membership: "local", controller: "locked-use",
      target: account.recordID, targetThumbprint: "", systemRecord: account.recordID,
      protectionVersion: "locked-use-v1")
  }
}
#endif
