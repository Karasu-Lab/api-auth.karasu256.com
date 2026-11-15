import { eq } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '@karasu-lab/db/schema';
import { AccountLinkDeleteRepository } from '../redis/account-link-repositories';
import { AuthorizedAppDeleteRepository } from '../redis/authorized-app-repositories';
import { SecuritySettingDeleteRepository } from '../redis/security-setting-repositories';
import { SessionJwtDeleteRepository } from '../redis/session-jwt-repositories';
import { SessionSourceDeleteRepository } from '../redis/session-source-repositories';
import { BatchWork, batchWorkStatusSchema, type BatchWorkStatus } from './batch-work';

const contextSchema = z.object({ sessionId: z.string().min(1), userId: z.string().min(1) });

export class RedisSessionCleanupWork extends BatchWork<typeof contextSchema> {
  readonly type = 'redis.cleanup-session';
  readonly contextSchema = contextSchema;
  status: BatchWorkStatus = batchWorkStatusSchema.enum.pending;

  async handle({ sessionId, userId }: z.output<typeof contextSchema>): Promise<void> {
    const [session] = await this.db
      .select({ expiresAt: schema.sessions.expiresAt })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .limit(1);
    if (session && session.expiresAt > new Date()) {
      super.reschedule(session.expiresAt);
      return;
    }
    const redisSession = { id: sessionId, userId, expiresAt: session?.expiresAt ?? new Date() };
    await Promise.all([
      new AuthorizedAppDeleteRepository(this.env, redisSession).delete(),
      new AccountLinkDeleteRepository(this.env, redisSession).delete(),
      new SecuritySettingDeleteRepository(this.env, redisSession).delete(),
      new SessionSourceDeleteRepository(this.env, redisSession).delete(),
      new SessionJwtDeleteRepository(this.env, redisSession).delete(),
    ]);
    super.complete();
  }
}
