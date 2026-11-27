import type { GenericOAuthUserInfo } from 'better-auth/plugins';

interface ProviderProfileEmailSource {
  id?: unknown;
  email?: unknown;
}

export class OAuthSignInFlow {
  static mapGithubImage(profile: GenericOAuthUserInfo): { image: string | undefined } {
    return { image: typeof profile.avatar_url === 'string' ? profile.avatar_url : undefined };
  }

  socialProfileMapper() {
    return async (profile: ProviderProfileEmailSource) => this.emailFromProviderUserId(profile);
  }

  githubProfileMapper() {
    return async (profile: GenericOAuthUserInfo) => ({
      ...OAuthSignInFlow.mapGithubImage(profile),
      ...this.emailFromProviderUserId(profile),
    });
  }

  private emailFromProviderUserId(profile: ProviderProfileEmailSource): { email: string } | Record<string, never> {
    if (typeof profile.email === 'string' && profile.email) return {};
    if (profile.id === undefined || profile.id === null) return {};
    const email = String(profile.id);
    return email ? { email } : {};
  }
}
