import { disableShareAvailability } from './providerShareAvailabilityTransport.js';
import { createAvailabilityPolicy } from './providerShareAvailabilityPolicyCore.js';
const policy = createAvailabilityPolicy(disableShareAvailability);

// The transport imports stores that capture these callbacks during startup.
// Hoisted entry points let that cycle finish before a policy operation runs.
export function withAvailabilityPolicyLock<T>(work: () => Promise<T>): Promise<T> {
  return policy.withAvailabilityPolicyLock(work);
}

export function rememberAvailabilityShare(shareId: string, providerId: string): Promise<void> {
  return policy.rememberAvailabilityShare(shareId, providerId);
}

export function withAvailabilityPolicyMutation<T>(providerId: string | undefined, work: () => Promise<T>): Promise<T> {
  return policy.withAvailabilityPolicyMutation(providerId, work);
}
