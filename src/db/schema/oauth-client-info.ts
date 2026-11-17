import {
    boolean,
    pgTable,
    text,
    timestamp,
    varchar,
} from "drizzle-orm/pg-core";
import { oauthClients } from "./oauth-clients";
import { users } from "./users";

export const oauthClientInfo = pgTable("oauth_client_info", {
    clientId: text("client_id")
        .primaryKey()
        .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    name: text("name").notNull(),
    authorId: varchar("author_id", { length: 128 }).references(() => users.id, {
        onDelete: "set null",
    }),
    iconUrl: text("icon_url"),
    description: text("description"),
    resource: text("resource"),
    public: boolean("public").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
        .defaultNow()
        .$onUpdate(() => new Date())
        .notNull(),
});

export type OAuthClientInfo = typeof oauthClientInfo.$inferSelect;
export type NewOAuthClientInfo = typeof oauthClientInfo.$inferInsert;
