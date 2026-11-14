import { z } from 'zod';
import { ensureFirebaseLink } from '../firebase-link';
import { BatchWork, batchWorkStatusSchema, type BatchWorkStatus } from './batch-work';

const contextSchema = z.object({ userId: z.string().min(1) });

export class FirebaseLinkUserWork extends BatchWork<typeof contextSchema> {
  readonly type = 'firebase.link-user';
  readonly contextSchema = contextSchema;
  status: BatchWorkStatus = batchWorkStatusSchema.enum.pending;

  async handle({ userId }: z.output<typeof contextSchema>): Promise<void> {
    await ensureFirebaseLink(this.env, this.db, userId);
    super.complete();
  }
}
