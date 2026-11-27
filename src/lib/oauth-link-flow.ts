import type { AuthContext } from '@better-auth/core';
import type { GenericOAuthConfig } from 'better-auth/plugins';
import { setTokenUtil } from 'better-auth/oauth2';
import { z } from 'zod';
import { xboxLinkStatePayloadSchema, type XboxLinkExchange, type XboxLinkTokens } from '@karasu-lab/types/server';
import type { Auth } from './auth';
import { getGithubOAuthProviders } from './github-providers';
import { getMockOAuthProviders, getMockOAuthUrl } from './mock-oauth';
import { getOAuthProxyConfig, oauthProxyRedirectURI, signProxyState, verifyProxyState, withOAuthProxyState } from './oauth-proxy';
import { withAuth } from './request-auth';
import { createSocialProviders } from './social-providers';
import { authenticateXboxLive, authorizeXsts, XBOX_RELYING_PARTY } from './xbox-live';

export type { XboxLinkExchange, XboxLinkTokens };

export class XboxLinkError extends Error {
  readonly error: string;
  readonly errorDescription: string | null;

  constructor(error: string, errorDescription?: string | null, cause?: unknown) {
    const description = errorDescription ?? (cause instanceof Error ? cause.message : cause != null ? String(cause) : null);
    super(description ?? error, cause !== undefined ? { cause } : undefined);
    this.name = 'XboxLinkError';
    this.error = error;
    this.errorDescription = description;
  }
}

const oauthLinkFlowConfigSchema = z.object({
  androidScheme: z
    .string()
    .regex(/^[a-z][a-z0-9+.-]*$/i)
    .default('karasulab'),
});

type OAuthLinkFlowConfig = z.output<typeof oauthLinkFlowConfigSchema>;

const linkRequestSchema = z.object({
  provider: z.string().max(128).regex(/^[a-z0-9-]+$/i),
  callbackURL: z.string().max(2048),
});

const linkStatePayloadSchema = xboxLinkStatePayloadSchema.extend({
  app: z.boolean().optional(),
  callbackURL: z.string().url().optional(),
  providerId: z.string().regex(/^[a-z0-9-]+$/i).optional(),
});

const handoffSchema = z.object({
  url: z.string().url(),
  cookies: z.array(z.string().max(8192)).max(20),
  expiresAt: z.number(),
});

type XboxLinkState = { userId: string; app: boolean; callbackURL?: string; providerId?: string };

export class OAuthLinkFlow {
  static readonly XBOX_PROVIDER_ID = 'xbox';
  private static readonly XBOX_SCOPE = 'XboxLive.signin offline_access';
  private static readonly MICROSOFT_AUTHORIZE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize';
  private static readonly MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
  private static readonly STATE_TTL_MS = 10 * 60 * 1000;
  private static readonly HANDOFF_TTL_MS = 5 * 60 * 1000;
  private static readonly STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

  private readonly env: Env;
  private readonly config: OAuthLinkFlowConfig;

  constructor(env: Env, config?: Partial<z.input<typeof oauthLinkFlowConfigSchema>>) {
    this.env = env;
    this.config = oauthLinkFlowConfigSchema.parse({ androidScheme: env.ANDROID_APP_SCHEME, ...config });
  }

  async startLink(request: Request): Promise<Response> {
    const input = await this.parseStartRequest(request, 'invalid_oauth_link_request');
    if (input instanceof Response) return input;

    const started =
      input.provider === OAuthLinkFlow.XBOX_PROVIDER_ID || input.provider === 'minecraft'
        ? await this.startXboxAppLink(request, input.callbackURL, input.provider)
        : await this.startProviderLink(request, input.provider, input.callbackURL);
    return this.respondWithHandoff(started, 'oauth_link_start_failed');
  }

  async startSignIn(request: Request): Promise<Response> {
    const input = await this.parseStartRequest(request, 'invalid_oauth_sign_in_request');
    if (input instanceof Response) return input;

    if (input.provider === OAuthLinkFlow.XBOX_PROVIDER_ID || input.provider === 'minecraft') {
      return Response.json({
        error: 'unsupported_oauth_provider',
        reason: `Provider '${input.provider}' is not configured for OAuth sign-in.`,
      }, { status: 400 });
    }

    const started = await this.startProviderSignIn(request, input.provider, input.callbackURL);
    return this.respondWithHandoff(started, 'oauth_sign_in_start_failed');
  }

  private async parseStartRequest(request: Request, requestError: string): Promise<{ provider: string; callbackURL: string } | Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Request body must be valid JSON.';
      return Response.json({ error: requestError, reason: `Could not parse JSON request body: ${reason}` }, { status: 400 });
    }

    const input = linkRequestSchema.safeParse(body);
    if (!input.success) {
      return Response.json({ error: requestError, reason: this.inputReason(input.error.issues) }, { status: 400 });
    }

    const callback = this.validateNativeCallback(input.data.callbackURL, input.data.provider);
    if ('reason' in callback) return Response.json({ error: 'invalid_oauth_callback', reason: callback.reason }, { status: 400 });
    return { provider: input.data.provider, callbackURL: callback.url.toString() };
  }

  private async respondWithHandoff(started: Response, startError: string): Promise<Response> {
    if (!started.ok) {
      return Response.json(await this.providerFailure(started, startError), { status: started.status });
    }

    let startedBody: unknown;
    try {
      startedBody = await started.json();
    } catch {
      return Response.json({ error: startError, reason: 'OAuth provider returned an unreadable response.' }, { status: 502 });
    }
    if (typeof startedBody !== 'object' || startedBody === null || !('url' in startedBody) || typeof startedBody.url !== 'string') {
      return Response.json({ error: startError, reason: 'OAuth provider response did not include an authorization URL.' }, { status: 502 });
    }

    let authorizationURL: URL;
    try {
      authorizationURL = new URL(startedBody.url);
    } catch {
      return Response.json({ error: startError, reason: 'OAuth provider returned an invalid authorization URL.' }, { status: 502 });
    }
    if (authorizationURL.protocol !== 'https:') {
      return Response.json({ error: startError, reason: 'OAuth authorization URL must use HTTPS.' }, { status: 502 });
    }

    let ticket: string;
    try {
      ticket = await this.createHandoff(authorizationURL.toString(), started.headers.getSetCookie());
    } catch (error) {
      console.error('Failed to create OAuth link handoff:', error);
      return Response.json({ error: 'oauth_link_handoff_failed', reason: 'Could not create a secure OAuth handoff.' }, { status: 500 });
    }
    const handoffURL = new URL('/api/oauth/link/continue', this.env.BETTER_AUTH_URL);
    handoffURL.searchParams.set('ticket', ticket);
    return Response.json({ url: handoffURL.toString() }, { headers: { 'cache-control': 'no-store' } });
  }

  async continueLink(request: Request): Promise<Response> {
    const ticket = new URL(request.url).searchParams.get('ticket');
    if (!ticket) return Response.json({ error: 'invalid_oauth_link_handoff', reason: 'The ticket query parameter is required.' }, { status: 400 });

    const handoff = await this.readHandoff(ticket);
    if (!handoff) {
      return Response.json({ error: 'invalid_oauth_link_handoff', reason: 'The ticket is malformed, expired, or failed integrity validation.' }, { status: 400 });
    }

    const headers = new Headers({
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      location: handoff.url,
    });
    for (const cookie of handoff.cookies) headers.append('set-cookie', cookie);
    return new Response(null, { status: 302, headers });
  }

  async startXboxLink(request: Request): Promise<Response> {
    const destination = await withAuth(this.env, async (auth: Auth) => {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) {
        const next = encodeURIComponent(`${this.env.BETTER_AUTH_URL.replace(/\/+$/, '')}/api/xbox/link`);
        return `${this.env.AUTH_UI_URL.replace(/\/+$/, '')}/sign-in?next=${next}`;
      }
      if (!this.env.MICROSOFT_CLIENT_ID) return this.linkingUrl();
      const state = await this.createLinkState(session.user.id);
      const signedState = await this.signStateForProxy(state);
      return this.buildAuthorizeUrl(this.env.MICROSOFT_CLIENT_ID, signedState);
    });
    return Response.redirect(destination, 302);
  }

  async startXboxAppLink(request: Request, callbackURL?: string, providerId: string = OAuthLinkFlow.XBOX_PROVIDER_ID): Promise<Response> {
    if (!this.env.MICROSOFT_CLIENT_ID) {
      return Response.json({
        error: 'xbox_link_not_configured',
        reason: 'Microsoft OAuth client ID is not configured.',
      }, { status: 503 });
    }
    const url = await withAuth(this.env, async (auth: Auth) => {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) return null;
      const state = await this.createLinkState(session.user.id, true, callbackURL, providerId);
      const signedState = await this.signStateForProxy(state);
      return this.buildAuthorizeUrl(this.env.MICROSOFT_CLIENT_ID!, signedState);
    });
    if (!url) return Response.json({ error: 'unauthorized', reason: 'An authenticated session is required to link an account.' }, { status: 401 });
    return Response.json({ url });
  }

  async finishXboxLink(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const forwardedState = url.searchParams.get('state');
    const state = forwardedState ? ((await verifyProxyState(this.env, forwardedState)) ?? forwardedState) : null;
    const linkState = state ? await this.verifyLinkState(state) : null;
    const destination = new URL(linkState?.callbackURL ?? (linkState?.app ? this.appCallbackUrl() : this.linkingUrl()));
    const fail = (error: string, errorDescription?: string | null) => {
      destination.searchParams.set('error', error);
      if (errorDescription) destination.searchParams.set('error_description', errorDescription);
      return Response.redirect(destination.toString(), 302);
    };

    const authorizeError = url.searchParams.get('error');
    if (authorizeError) return fail(authorizeError, url.searchParams.get('error_description'));

    const code = url.searchParams.get('code');
    if (!code || !state) return fail('xbox_link_missing_code', 'Microsoft did not return an authorization code.');
    if (!this.env.MICROSOFT_CLIENT_ID || !this.env.MICROSOFT_CLIENT_SECRET) {
      return fail('xbox_link_not_configured', 'The Microsoft client credentials are not configured on the server.');
    }

    try {
      await withAuth(this.env, async (auth: Auth) => {
        if (!linkState) throw new XboxLinkError('xbox_link_state_invalid', 'The link state was invalid or expired.');
        if (!linkState.app) {
          const session = await auth.api.getSession({ headers: request.headers });
          if (!session || session.user.id !== linkState.userId) {
            throw new XboxLinkError('xbox_link_session_mismatch', 'The session does not match the user who started the Xbox link.');
          }
        }

        const exchange = await this.exchangeCode(code);
        if (!exchange.tokens) throw new XboxLinkError(exchange.error ?? 'xbox_token_exchange_failed', exchange.errorDescription);

        const ctx = (await auth.$context) as unknown as AuthContext;
        try {
          await this.storeProviderUser(ctx, linkState.userId, exchange.tokens);
        } catch (error) {
          throw new XboxLinkError('xbox_live_rejected', null, error);
        }
      });
    } catch (error) {
      if (error instanceof XboxLinkError) return fail(error.error, error.errorDescription);
      throw error;
    }

    destination.searchParams.set('linked', linkState?.providerId ?? OAuthLinkFlow.XBOX_PROVIDER_ID);
    return Response.redirect(destination.toString(), 302);
  }

  private async startProviderLink(request: Request, provider: string, nativeCallbackURL: string): Promise<Response> {
    if (!this.isProviderConfigured(provider)) {
      return Response.json({
        error: 'unsupported_oauth_provider',
        reason: `Provider '${provider}' is not configured for OAuth linking.`,
      }, { status: 400 });
    }

    const linkCallback = new URL('/auth/callback', this.env.AUTH_UI_URL);
    linkCallback.searchParams.set('next', nativeCallbackURL);
    linkCallback.searchParams.set('flow', 'link');

    return withAuth(this.env, async (auth) => {
      const headers = new Headers(request.headers);
      headers.set('content-type', 'application/json');
      headers.delete('content-length');
      const authRequest = new Request(`${this.env.BETTER_AUTH_URL.replace(/\/+$/, '')}/api/auth/link-social`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          provider,
          callbackURL: linkCallback.toString(),
          errorCallbackURL: linkCallback.toString(),
          disableRedirect: true,
        }),
      });
      return withOAuthProxyState(this.env, 'POST', '/api/auth/link-social', await auth.handler(authRequest));
    });
  }

  private async startProviderSignIn(request: Request, provider: string, nativeCallbackURL: string): Promise<Response> {
    if (!this.isProviderConfigured(provider)) {
      return Response.json({
        error: 'unsupported_oauth_provider',
        reason: `Provider '${provider}' is not configured for OAuth sign-in.`,
      }, { status: 400 });
    }

    const signInCallback = new URL('/auth/callback', this.env.AUTH_UI_URL);
    signInCallback.searchParams.set('next', nativeCallbackURL);

    const pathname = '/api/auth/sign-in/social';
    return withAuth(this.env, async (auth) => {
      const headers = new Headers(request.headers);
      headers.set('content-type', 'application/json');
      headers.delete('content-length');
      headers.delete('cookie');
      const authRequest = new Request(`${this.env.BETTER_AUTH_URL.replace(/\/+$/, '')}${pathname}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          provider,
          callbackURL: signInCallback.toString(),
          errorCallbackURL: signInCallback.toString(),
          disableRedirect: true,
        }),
      });
      return withOAuthProxyState(this.env, 'POST', pathname, await auth.handler(authRequest));
    });
  }

  private isProviderConfigured(providerId: string): boolean {
    return this.isSocialProvider(providerId) || this.genericProviders().some((provider) => provider.providerId === providerId);
  }

  private isSocialProvider(providerId: string): boolean {
    return Object.prototype.hasOwnProperty.call(createSocialProviders(this.env), providerId);
  }

  private genericProviders(): GenericOAuthConfig[] {
    const mockUrl = getMockOAuthUrl(this.env);
    return mockUrl ? getMockOAuthProviders(mockUrl) : getGithubOAuthProviders(this.env);
  }

  private validateNativeCallback(callbackURL: string, provider: string): { url: URL } | { reason: string } {
    let url: URL;
    try {
      url = new URL(callbackURL);
    } catch {
      return { reason: 'callbackURL must be a valid URI.' };
    }

    if (url.protocol !== `${this.config.androidScheme}:`) return { reason: `callbackURL must use the ${this.config.androidScheme}:// scheme.` };
    if (url.hostname !== 'api') return { reason: 'callbackURL host must be api.' };
    if (url.pathname !== `/auth/callback/${provider}`) return { reason: 'callbackURL path must match the requested provider.' };
    if (url.username || url.password || url.port || url.hash) {
      return { reason: 'callbackURL must not contain credentials, a port, or a fragment.' };
    }

    const states = url.searchParams.getAll('state');
    if (states.length !== 1) return { reason: 'callbackURL must contain exactly one state parameter.' };
    if (!OAuthLinkFlow.STATE_PATTERN.test(states[0] ?? '')) return { reason: 'callbackURL state must be 16 to 128 URL-safe characters.' };
    if ([...url.searchParams.keys()].some((key) => key !== 'state')) {
      return { reason: 'callbackURL may only contain the state query parameter.' };
    }
    return { url };
  }

  private inputReason(issues: z.ZodError['issues']): string {
    return issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ');
  }

  private providerFailure(response: Response, fallbackError: string): Promise<{ error: string; reason: string }> {
    return response
      .clone()
      .json()
      .then((body: unknown) => {
        if (typeof body !== 'object' || body === null) {
          return {
            error: fallbackError,
            reason: `OAuth provider request failed with status ${response.status}.`,
          };
        }
        const record = body as Record<string, unknown>;
        const message = record.reason ?? record.message ?? record.error_description ?? record.error;
        const code = record.error ?? record.code;
        return {
          error: typeof code === 'string' && /^[A-Za-z0-9_-]+$/.test(code) ? code : fallbackError,
          reason: typeof message === 'string' ? message : `OAuth provider request failed with status ${response.status}.`,
        };
      })
      .catch(() => ({
        error: fallbackError,
        reason: `OAuth provider request failed with status ${response.status}.`,
      }));
  }

  private async createHandoff(url: string, cookies: string[]): Promise<string> {
    const authorizationURL = new URL(url);
    if (authorizationURL.protocol !== 'https:') throw new Error('OAuth authorization URL must use HTTPS');
    if (cookies.length > 20 || cookies.some((cookie) => cookie.length > 8192)) {
      throw new Error('OAuth link state cookies exceed the handoff limit');
    }

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(
      JSON.stringify({ url: authorizationURL.toString(), cookies, expiresAt: Date.now() + OAuthLinkFlow.HANDOFF_TTL_MS }),
    );
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.handoffKey(), plaintext);
    const ticket = `${this.encodeBase64Url(iv)}.${this.encodeBase64Url(new Uint8Array(ciphertext))}`;
    if (ticket.length > 16_384) throw new Error('OAuth link handoff exceeds the ticket limit');
    return ticket;
  }

  private async readHandoff(ticket: string, now = Date.now()): Promise<{ url: string; cookies: string[] } | null> {
    if (ticket.length > 16_384) return null;
    const [encodedIv, encodedCiphertext, extra] = ticket.split('.');
    if (!encodedIv || !encodedCiphertext || extra) return null;

    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: this.decodeBase64Url(encodedIv) },
        await this.handoffKey(),
        this.decodeBase64Url(encodedCiphertext),
      );
      const parsed = handoffSchema.safeParse(JSON.parse(new TextDecoder().decode(plaintext)));
      if (!parsed.success || parsed.data.expiresAt < now || parsed.data.cookies.some((cookie) => cookie.length > 8192)) return null;
      if (new URL(parsed.data.url).protocol !== 'https:') return null;
      return { url: parsed.data.url, cookies: parsed.data.cookies };
    } catch {
      return null;
    }
  }

  private async handoffKey(): Promise<CryptoKey> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.env.BETTER_AUTH_SECRET));
    return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  private linkingUrl(): string {
    return `${this.env.ACCOUNTS_URL.replace(/\/+$/, '')}/settings/linking`;
  }

  private appCallbackUrl(): string {
    return `${this.env.ACCOUNTS_URL.replace(/\/+$/, '')}/auth/app/callback`;
  }

  private xboxCallbackUrl(): string {
    return (
      oauthProxyRedirectURI(this.env, OAuthLinkFlow.XBOX_PROVIDER_ID) ??
      `${this.env.BETTER_AUTH_URL.replace(/\/+$/, '')}/api/xbox/callback`
    );
  }

  private async signStateForProxy(state: string): Promise<string> {
    const config = getOAuthProxyConfig(this.env);
    if (!config?.secret) return state;
    return signProxyState({ origin: config.origin, ttlMs: config.ttlMs, secret: config.secret }, state);
  }

  private buildAuthorizeUrl(clientId: string, state: string): string {
    const url = new URL(OAuthLinkFlow.MICROSOFT_AUTHORIZE_URL);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', this.xboxCallbackUrl());
    url.searchParams.set('scope', OAuthLinkFlow.XBOX_SCOPE);
    url.searchParams.set('state', state);
    url.searchParams.set('prompt', 'select_account');
    return url.toString();
  }

  private async createLinkState(userId: string, app = false, callbackURL?: string, providerId: string = OAuthLinkFlow.XBOX_PROVIDER_ID): Promise<string> {
    const payload = this.encodeBase64Url(
      new TextEncoder().encode(
        JSON.stringify({
          userId,
          exp: Date.now() + OAuthLinkFlow.STATE_TTL_MS,
          ...(app && { app }),
          ...(callbackURL && { callbackURL, providerId }),
        })
      )
    );
    const signature = await crypto.subtle.sign('HMAC', await this.stateKey(), new TextEncoder().encode(payload));
    return `${payload}.${this.encodeBase64Url(new Uint8Array(signature))}`;
  }

  private async verifyLinkState(state: string): Promise<XboxLinkState | null> {
    const [payload, signature] = state.split('.');
    if (!payload || !signature) return null;
    const valid = await crypto.subtle
      .verify('HMAC', await this.stateKey(), this.decodeBase64Url(signature), new TextEncoder().encode(payload))
      .catch(() => false);
    if (!valid) return null;
    try {
      const parsed = linkStatePayloadSchema.safeParse(JSON.parse(new TextDecoder().decode(this.decodeBase64Url(payload))));
      if (!parsed.success || parsed.data.exp < Date.now()) return null;
      return {
        userId: parsed.data.userId,
        app: parsed.data.app === true,
        callbackURL: parsed.data.callbackURL,
        providerId: parsed.data.providerId,
      };
    } catch {
      return null;
    }
  }

  private async stateKey(): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', new TextEncoder().encode(this.env.BETTER_AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  }

  private async exchangeCode(code: string): Promise<XboxLinkExchange> {
    const res = await fetch(OAuthLinkFlow.MICROSOFT_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.env.MICROSOFT_CLIENT_ID!,
        client_secret: this.env.MICROSOFT_CLIENT_SECRET!,
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.xboxCallbackUrl(),
        scope: OAuthLinkFlow.XBOX_SCOPE,
      }),
    }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    } | null;
    if (!res?.ok || !body?.access_token) {
      return {
        tokens: null,
        error: body?.error ?? 'xbox_token_exchange_failed',
        errorDescription: body?.error_description ?? `Microsoft's token endpoint answered ${res?.status ?? 'no response'}.`,
      };
    }
    return {
      tokens: {
        accessToken: body.access_token,
        refreshToken: body.refresh_token ?? null,
        accessTokenExpiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
      },
      error: null,
      errorDescription: null,
    };
  }

  private async storeProviderUser(ctx: AuthContext, userId: string, tokens: XboxLinkTokens): Promise<string> {
    const xboxLive = await authenticateXboxLive(tokens.accessToken);
    const xsts = await authorizeXsts(xboxLive.token, XBOX_RELYING_PARTY);
    const xuid = xsts.xuid ?? xboxLive.xuid;
    if (!xuid) throw new Error('Xbox Live authentication did not return a user ID.');

    const data = {
      accountId: xuid,
      accessToken: await setTokenUtil(tokens.accessToken, ctx),
      refreshToken: (await setTokenUtil(tokens.refreshToken, ctx)) ?? null,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      scope: OAuthLinkFlow.XBOX_SCOPE,
    };
    const existing = (await ctx.internalAdapter.findAccounts(userId)).find((account) => account.providerId === OAuthLinkFlow.XBOX_PROVIDER_ID);
    if (existing) {
      await ctx.internalAdapter.updateAccount(existing.id, data);
    } else {
      await ctx.internalAdapter.createAccount({ userId, providerId: OAuthLinkFlow.XBOX_PROVIDER_ID, ...data });
    }
    return xuid;
  }

  private encodeBase64Url(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  private decodeBase64Url(value: string): Uint8Array {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }
}
