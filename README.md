# api-auth.karasu256.com

The single Better Auth instance for Karasu Lab — email/password, Google and GitHub sign-in, passkeys, API keys, OAuth 2.1 / OIDC provider, and SAML SSO — running as a Cloudflare Worker. Split out of [Karasu-Lab/karasu256.com](https://github.com/Karasu-Lab/karasu256.com).

## Required environment variables

The deploy workflow (`.github/workflows/api-auth-deploy.yml`) reads the following GitHub Actions secrets and variables. Register them on this repository under exactly these names. Values are never committed to the repository.

### Deployment

| Name | Kind | Used for |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Secret | Authenticating wrangler against Cloudflare |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | The Cloudflare account the worker is deployed to |

### Worker secrets

These are synced to the production worker on every deploy to `main`.

| Name | Used for |
| --- | --- |
| `BETTER_AUTH_SECRET` | Better Auth's core secret (session signing and private-key encryption) |
| `AUTH_SECRET` | Legacy Neon Auth sync secret |
| `INTERNAL_API_SECRET` | Shared secret for internal API calls |
| `DATABASE_URL` | Connection string of the database holding the auth accounts |
| `FIREBASE_ADMIN_PROJECT_ID` | Firebase project for the lazy Firebase UID linking |
| `FIREBASE_ADMIN_CLIENT_EMAIL` | Firebase Admin service account email |
| `FIREBASE_ADMIN_PRIVATE_KEY` | Firebase Admin service account private key |
| `RESEND_API_KEY` | Resend API key used to send password reset email |
| `RESEND_FROM_EMAIL` | Sender address for password reset email |
| `NEON_AUTH_BASE_URL` | Base URL of the Neon Auth instance used for shadow-account sync |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GH_CLIENT_ID` | GitHub OAuth client ID, passed to the worker as `GITHUB_CLIENT_ID` (GitHub reserves the `GITHUB_` prefix, so the Actions secret uses the `GH_` name) |
| `GH_CLIENT_SECRET` | GitHub OAuth client secret, passed to the worker as `GITHUB_CLIENT_SECRET` |

If one of these secrets is unset, the sync falls back to the default in the worker's `wrangler.jsonc` local environment, and skips the entry when it is defined in neither place.

### Branch previews

Pushes to non-`main` branches deploy a preview worker. Previews share the values above except for the following, which have dedicated preview variants: `PREVIEW_FIREBASE_ADMIN_PROJECT_ID`, `PREVIEW_FIREBASE_ADMIN_CLIENT_EMAIL`, `PREVIEW_FIREBASE_ADMIN_PRIVATE_KEY`, `PREVIEW_RESEND_API_KEY`, `PREVIEW_RESEND_FROM_EMAIL`, `PREVIEW_NEON_AUTH_BASE_URL`, `PREVIEW_GOOGLE_CLIENT_ID`, `PREVIEW_GOOGLE_CLIENT_SECRET`, `PREVIEW_GH_CLIENT_ID`, `PREVIEW_GH_CLIENT_SECRET`.
