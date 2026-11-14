import { z } from 'zod';
import { deleteFirebaseUser } from '../firebase';
import { BatchWork, batchWorkStatusSchema, type BatchWorkStatus } from './batch-work';

const contextSchema = z.object({ firebaseUid: z.string().min(1) });

export class FirebaseDeleteUserWork extends BatchWork<typeof contextSchema> {
  readonly type = 'firebase.delete-user';
  readonly contextSchema = contextSchema;
  status: BatchWorkStatus = batchWorkStatusSchema.enum.pending;

  async handle({ firebaseUid }: z.output<typeof contextSchema>): Promise<void> {
    await deleteFirebaseUser(this.env, firebaseUid);
    super.complete();
  }
}
