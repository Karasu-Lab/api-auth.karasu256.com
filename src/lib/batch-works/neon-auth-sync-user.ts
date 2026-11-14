import { z } from 'zod';
import { syncUserToNeonAuth } from '../neon-auth';
import { BatchWork, batchWorkStatusSchema, type BatchWorkStatus } from './batch-work';

const contextSchema = z.object({ id: z.string().min(1), email: z.string().nullable(), name: z.string().nullable() });

export class NeonAuthSyncUserWork extends BatchWork<typeof contextSchema> {
  readonly type = 'neon-auth.sync-user';
  readonly contextSchema = contextSchema;
  status: BatchWorkStatus = batchWorkStatusSchema.enum.pending;

  async handle(user: z.output<typeof contextSchema>): Promise<void> {
    await syncUserToNeonAuth(this.env, user);
    super.complete();
  }
}
