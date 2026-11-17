import {
    index,
    pgEnum,
    pgTable,
    text,
    timestamp,
    varchar,
} from "drizzle-orm/pg-core";

export const batchWorkStatus = pgEnum("batch_work_status", [
    "pending",
    "syncing",
    "completed",
    "error",
]);

export const batchWorks = pgTable(
    "batch_works",
    {
        id: varchar("id", { length: 128 }).primaryKey(),
        type: varchar("type", { length: 64 }).notNull(),
        status: batchWorkStatus("status").default("pending").notNull(),
        error: text("error"),
        context: text("context").notNull(),
        scheduledAt: timestamp("scheduled_at").defaultNow().notNull(),
        startedAt: timestamp("started_at"),
        finishedAt: timestamp("finished_at"),
    },
    (t) => [
        index("batch_works_status_scheduled_at_idx").on(
            t.status,
            t.scheduledAt,
        ),
    ],
);

export type BatchWork = typeof batchWorks.$inferSelect;
export type NewBatchWork = typeof batchWorks.$inferInsert;
export type BatchWorkStatus = (typeof batchWorkStatus.enumValues)[number];
