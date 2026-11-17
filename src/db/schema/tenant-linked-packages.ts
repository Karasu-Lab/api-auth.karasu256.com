import { createId } from "@paralleldrive/cuid2";
import {
    bigint,
    boolean,
    index,
    pgTable,
    text,
    timestamp,
    uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const tenantLinkedPackages = pgTable(
    "tenant_linked_package",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => createId()),
        organizationId: text("organization_id")
            .notNull()
            .references(() => organizations.id, { onDelete: "cascade" }),
        repositoryId: bigint("repository_id", { mode: "number" }).notNull(),
        repositoryFullName: text("repository_full_name").notNull(),
        npmSubmodulePath: text("npm_submodule_path").notNull(),
        versionNaming: text("version_naming").notNull(),
        webhookEnabled: boolean("webhook_enabled").default(true).notNull(),
        lastSyncedSha: text("last_synced_sha"),
        createdAt: timestamp("created_at").defaultNow().notNull(),
        updatedAt: timestamp("updated_at")
            .defaultNow()
            .$onUpdate(() => new Date())
            .notNull(),
    },
    (t) => [
        index("tenant_linked_package_organizationId_idx").on(t.organizationId),
        uniqueIndex(
            "tenant_linked_package_organizationId_repositoryId_uidx",
        ).on(t.organizationId, t.repositoryId),
    ],
);

export type TenantLinkedPackage = typeof tenantLinkedPackages.$inferSelect;
export type NewTenantLinkedPackage = typeof tenantLinkedPackages.$inferInsert;
