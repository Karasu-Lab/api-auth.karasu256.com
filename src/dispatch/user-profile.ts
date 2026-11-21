import { waitUntil } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { BadRequestError, NotFoundError } from '@karasu-lab/types/server';
import { updateUserProfileRequestSchema, type UserProfile } from '@karasu-lab/types/shared';
import { createDb } from '../db/create-db';
import { users } from '../db/schema';
import type { Dispatchable, DispatchContext } from '../lib/dispatch';

const PROFILE_PATH = /^\/api\/internal\/users\/([^/]+)\/profile$/;

function matchUserId(pathname: string): string | null {
  const match = PROFILE_PATH.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Reads a user's profile. Only reachable by signed internal requests. */
export class GetUserProfileDispatch implements Dispatchable {
  private context: DispatchContext;
  private userId: string | null = null;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    if (this.context.request.method !== 'GET') return false;
    this.userId = matchUserId(this.context.pathname);
    return this.userId !== null;
  }

  async handle(): Promise<Response> {
    const db = createDb(this.context.env.DATABASE_URL);
    try {
      const [row] = await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(eq(users.id, this.userId as string));
      if (!row) throw new NotFoundError();
      const profile: UserProfile = row;
      return Response.json(profile);
    } finally {
      waitUntil(db.$client.end());
    }
  }
}

/** Updates a user's profile name. Only reachable by signed internal requests. */
export class UpdateUserProfileDispatch implements Dispatchable {
  private context: DispatchContext;
  private userId: string | null = null;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    if (this.context.request.method !== 'PATCH') return false;
    this.userId = matchUserId(this.context.pathname);
    return this.userId !== null;
  }

  async handle(): Promise<Response> {
    const parsed = updateUserProfileRequestSchema.safeParse(this.context.body);
    if (!parsed.success) throw new BadRequestError();

    const db = createDb(this.context.env.DATABASE_URL);
    try {
      const [row] = await db
        .update(users)
        .set({ name: parsed.data.name, updatedAt: new Date() })
        .where(eq(users.id, this.userId as string))
        .returning({ id: users.id, name: users.name });
      if (!row) throw new NotFoundError();
      const profile: UserProfile = row;
      return Response.json(profile);
    } finally {
      waitUntil(db.$client.end());
    }
  }
}
