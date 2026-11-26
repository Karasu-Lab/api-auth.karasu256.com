# api-auth.karasu256.com

The single Better Auth instance for Karasu Lab — email/password, Google, GitHub and Microsoft sign-in, passkeys, API keys, OAuth 2.1 / OIDC provider, and SAML SSO — running as a Cloudflare Worker. The Microsoft link also backs the derived Xbox Live and Minecraft provider profiles (see `src/lib/xbox-live.ts`). Split out of [Karasu-Lab/Karasu-Lab](https://github.com/Karasu-Lab/Karasu-Lab).

It is deployed as two separate workers by `.github/workflows/deploy.yml`: `api-auth-karasu256-com` serves production (`api-auth.karasu256.com`) from `main`, and `dev-api-auth-karasu256-com` serves the preview environment on `dev-api-auth.karasu256.com` (the `dev` environment in `wrangler.jsonc`, selected with `CLOUDFLARE_ENV=dev`) from every other branch. Per-branch Previews are not used. The non-secret variables (`APP_ENV`, `BETTER_AUTH_URL`, `AUTH_UI_URL`, and so on) are not defined in `wrangler.jsonc`; they are injected from the `production` / `preview` GitHub Environment variables (or repository-level variables when both share a value) through `secret-names`.

Set the GitHub Actions variable `ANDROID_DEEPLINK_INFO` to a JSON object keyed by Android package name. Each value must include SHA-256 signing fingerprints and custom URI schemes, for example:

```json
{
  "com.karasu256.karasulab": {
    "fingerprints": ["00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF"],
    "protocols": ["karasulab://"]
  }
}
```

The worker publishes the fingerprints as standard Digital Asset Links at `/.well-known/assetlinks.json`; custom URI schemes remain app-manifest configuration because they are not part of the Digital Asset Links format.
