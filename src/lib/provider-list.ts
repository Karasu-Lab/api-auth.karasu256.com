import { createSocialProviders } from './social-providers';

export function listProviderIds(env: Env): string[] {
  const socialIds = Object.keys(createSocialProviders(env));
  return [...socialIds, ...(socialIds.includes('microsoft') ? ['xbox'] : []), 'minecraft', 'passkey'];
}
