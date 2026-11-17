import { createId } from "@paralleldrive/cuid2";
import {
    bigint,
    boolean,
    pgTable,
    text,
    timestamp,
    varchar,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

export const tenantGithubInstallations = pgTable("tenant_github_installation", {
    id: text("id")
        .primaryKey()
        .$defaultFn(() => createId()),
    organizationId: text("organization_id")
        .notNull()
        .unique()
        .references(() => organizations.id, { onDelete: "cascade" }),
    installationId: bigint("installation_id", { mode: "number" })
        .notNull()
        .unique(),
    targetType: text("target_type").notNull(),
    targetId: bigint("target_id", { mode: "number" }).notNull(),
    targetLogin: text("target_login").notNull(),
    installedByUserId: varchar("installed_by_user_id", {
        length: 128,
    }).references(() => users.id, { onDelete: "set null" }),
    suspended: boolean("suspended").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
        .defaultNow()
        .$onUpdate(() => new Date())
        .notNull(),
});

export type TenantGithubInstallation =
    typeof tenantGithubInstallations.$inferSelect;
export type NewTenantGithubInstallation =
    typeof tenantGithubInstallations.$inferInsert;
