import { createDb } from '@karasu-lab/db/create-db';
import { userSigningKeys, users } from '@karasu-lab/db/schema';
import { waitUntil } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { HttpError } from '@karasu-lab/types/server';
import type { Dispatchable, DispatchContext } from '../lib/dispatch';
import { withAuth } from '../lib/request-auth';
import { decryptSigningKeyPrivateKey } from '../lib/signing-key';

function userMaterialSegment(pathname: string): string | null {
  const prefix = '/api/internal/users/';
  const suffix = '/signing-key-material';
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
  const id = pathname.slice(prefix.length, pathname.length - suffix.length);
  return id.length > 0 && !id.includes('/') ? id : null;
}

export class SigningKeyMaterialDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return userMaterialSegment(this.context.pathname) !== null && this.context.request.method === 'POST';
  }

  async handle(): Promise<Response> {
    const { env } = this.context;
    const userId = userMaterialSegment(this.context.pathname)!;
    const db = createDb(env.DATABASE_URL);
    try {
      const payload = await withAuth(env, async (auth) => {
        const keyRows = await db.select().from(userSigningKeys).where(eq(userSigningKeys.userId, userId)).limit(1);
        const key = keyRows[0];
        if (!key) throw new HttpError(404, { error: 'signing_key_not_registered' });
        if (!key.enabled) throw new HttpError(409, { error: 'signing_key_disabled' });
        const userRows = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
        const user = userRows[0];
        if (!user?.name || !user?.email) throw new HttpError(422, { error: 'committer_identity_incomplete' });
        const privateKey = await decryptSigningKeyPrivateKey(auth, key.encryptedPrivateKey);
        if (!privateKey) throw new HttpError(500, { error: 'signing_key_decryption_failed' });
        return {
          userId,
          privateKey,
          publicKey: key.publicKey,
          committerName: user.name,
          committerEmail: user.email,
        };
      });
      return Response.json(payload);
    } finally {
      waitUntil(db.$client.end());
    }
  }
}
