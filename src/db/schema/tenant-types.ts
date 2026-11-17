import { pgTable, text } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const tenantTypes = pgTable("tenant_types", {
    tenantId: text("tenant_id")
        .primaryKey()
        .references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
});

export type TenantTypeRow = typeof tenantTypes.$inferSelect;
export type NewTenantTypeRow = typeof tenantTypes.$inferInsert;
