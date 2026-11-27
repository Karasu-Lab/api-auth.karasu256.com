import { and, eq } from 'drizzle-orm';
import type { GenericOAuthUserInfo } from 'better-auth/plugins';
import type { Db } from '../db/create-db';
import * as schema from '../db/schema';

interface ProviderProfileEmailSource {
  id?: unknown;
  email?: unknown;
}

export class OAuthSignInFlow {
  constructor(private readonly db: Db | null) {}

  static mapGithubImage(profile: GenericOAuthUserInfo): { image: string | undefined } {
    return { image: typeof profile.avatar_url === 'string' ? profile.avatar_url : undefined };
  }

  socialProfileMapper(providerId: string) {
    return async (profile: ProviderProfileEmailSource) => this.emailFallback(providerId, profile);
  }

  githubProfileMapper(providerId: string) {
    return async (profile: GenericOAuthUserInfo) => ({
      ...OAuthSignInFlow.mapGithubImage(profile),
      ...(await this.emailFallback(providerId, profile)),
    });
  }

  private async emailFallback(
    providerId: string,
    profile: ProviderProfileEmailSource
  ): Promise<{ email: string } | Record<string, never>> {
    if (typeof profile.email === 'string' && profile.email) return {};
    if (profile.id === undefined || profile.id === null) return {};
    const email = await this.findLinkedAccountEmail(providerId, String(profile.id)).catch(() => null);
    return email ? { email } : {};
  }

  private async findLinkedAccountEmail(providerId: string, providerUserId: string): Promise<string | null> {
    if (!this.db) return null;
    const [row] = await this.db
      .select({ email: schema.users.email })
      .from(schema.accounts)
      .innerJoin(schema.users, eq(schema.accounts.userId, schema.users.id))
      .where(and(eq(schema.accounts.providerId, providerId), eq(schema.accounts.accountId, providerUserId)))
      .limit(1);
    return row?.email ?? null;
  }
}
