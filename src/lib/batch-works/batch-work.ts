import { and, eq, lte } from 'drizzle-orm';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { z } from 'zod';
import type { Db } from '@karasu-lab/db/create-db';
import * as schema from '@karasu-lab/db/schema';

export const batchWorkStatusSchema = z.enum(schema.batchWorkStatus.enumValues);

export type BatchWorkStatus = z.output<typeof batchWorkStatusSchema>;

export abstract class BatchWork<TContextSchema extends z.ZodType> {
  abstract readonly type: string;
  abstract readonly contextSchema: TContextSchema;
  abstract status: BatchWorkStatus;
  id: string = crypto.randomUUID();
  context = '';
  error: string | null = null;
  scheduledAt = new Date();
  startedAt: Date | null = null;
  finishedAt: Date | null = null;

  constructor(
    protected readonly env: Env,
    protected readonly db: Db
  ) {}

  abstract handle(context: z.output<TContextSchema>): Promise<void>;

  staleAfterMs(): number {
    return 15 * 60 * 1000;
  }

  async read(): Promise<void> {
    const [row] = await this.db.select().from(schema.batchWorks).where(eq(schema.batchWorks.id, this.id)).limit(1);
    this.status = row.status;
    this.context = row.context;
    this.error = row.error;
    this.scheduledAt = row.scheduledAt;
    this.startedAt = row.startedAt;
    this.finishedAt = row.finishedAt;
  }

  async write(): Promise<void> {
    const values = {
      type: this.type,
      status: this.status,
      context: this.context,
      error: this.error,
      scheduledAt: this.scheduledAt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
    };
    await this.db
      .insert(schema.batchWorks)
      .values({ id: this.id, ...values })
      .onConflictDoUpdate({ target: schema.batchWorks.id, set: values });
  }

  async enqueue(context: z.input<TContextSchema>): Promise<void> {
    this.context = await this.encrypt(JSON.stringify(this.contextSchema.parse(context)));
    await this.write();
  }

  async run(): Promise<void> {
    try {
      const context = this.contextSchema.parse(JSON.parse(await this.decrypt(this.context)));
      await this.handle(context);
    } catch (error) {
      await this.fail(error);
    }
    await this.write();
  }

  protected complete(): void {
    this.status = batchWorkStatusSchema.enum.completed;
    this.finishedAt = new Date();
  }

  protected async fail(error: unknown): Promise<void> {
    this.status = batchWorkStatusSchema.enum.error;
    this.error = await this.encrypt(error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error));
    this.finishedAt = new Date();
  }

  async failStale(): Promise<void> {
    await this.db
      .update(schema.batchWorks)
      .set({ status: batchWorkStatusSchema.enum.error, finishedAt: new Date() })
      .where(
        and(
          eq(schema.batchWorks.type, this.type),
          eq(schema.batchWorks.status, batchWorkStatusSchema.enum.syncing),
          lte(schema.batchWorks.startedAt, new Date(Date.now() - this.staleAfterMs()))
        )
      );
  }

  private encrypt(data: string): Promise<string> {
    return symmetricEncrypt({ key: this.env.BETTER_AUTH_SECRET, data });
  }

  private decrypt(data: string): Promise<string> {
    return symmetricDecrypt({ key: this.env.BETTER_AUTH_SECRET, data });
  }
}
