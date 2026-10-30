# api-auth.karasu256.com

The single Better Auth instance for Karasu Lab — email/password, Google and GitHub sign-in, passkeys, API keys, OAuth 2.1 / OIDC provider, and SAML SSO — running as a Cloudflare Worker. Split out of [Karasu-Lab/Karasu-Lab](https://github.com/Karasu-Lab/Karasu-Lab).

## Required environment variables

Both jobs are thin wrappers around the shared [`deploy-worker`](https://github.com/Karasu-Lab/Workers) action (`Karasu-Lab/Workers/deploy-worker@v1`): the workflow only maps this app's names into the environment and passes its commands as parameters, and the action assembles the workspace, deploys, and prunes branch Previews to the newest five. The deploy workflow (`.github/workflows/api-auth-deploy.yml`) reads the following GitHub Actions secrets and variables, organized by GitHub Environments. The production job runs in the `production` environment and the preview job in the `preview` environment (a `development` environment also exists); register each name at repository level as the default, and override it inside an environment only where that environment needs a different value — a name an environment does not define falls back to the repository-level entry. Values are never committed to the repository. Identifiers that are not confidential (client IDs and similar) are variables, not secrets.

### Deployment

| Name | Kind | Used for |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Secret | Authenticating wrangler against Cloudflare |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | The Cloudflare account the worker is deployed to |

### Worker secrets

These are synced to the worker on every deploy; previews resolve the same names from the `preview` environment.

| Name | Used for |
| --- | --- |
| `BETTER_AUTH_SECRET` | Better Auth's core secret (session signing and private-key encryption) |
| `AUTH_SECRET` | Legacy Neon Auth sync secret |
| `INTERNAL_API_SECRET` | Shared secret for internal API calls |
| `DATABASE_URL` | Connection string of the database holding the auth accounts |
| `FIREBASE_ADMIN_PRIVATE_KEY` | Firebase Admin service account private key |
| `RESEND_API_KEY` | Resend API key used to send password reset email |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GH_CLIENT_SECRET` | GitHub OAuth client secret, passed to the worker as `GITHUB_CLIENT_SECRET` |

### Worker variables

Non-secret identifiers, synced to the worker alongside the secrets.

| Name | Used for |
| --- | --- |
| `GOOGLE_CLOUD_PROJECT_ID` | Firebase project for the lazy Firebase UID linking |
| `FIREBASE_ADMIN_CLIENT_EMAIL` | Firebase Admin service account email |
| `RESEND_FROM_EMAIL` | Sender address for password reset email |
| `NEON_AUTH_BASE_URL` | Base URL of the Neon Auth instance used for shadow-account sync |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GH_CLIENT_ID` | GitHub OAuth client ID, passed to the worker as `GITHUB_CLIENT_ID` (GitHub reserves the `GITHUB_` prefix, so the Actions entry uses the `GH_` name) |

If one of these entries is unset everywhere, the sync falls back to the default in the worker's `wrangler.jsonc` local environment, and skips the entry when it is defined in neither place.
