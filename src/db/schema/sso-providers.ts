import { pgTable, text, varchar } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * `@better-auth/sso`'s `ssoProvider` model. One row per identity provider
 * an organization registers for single sign-on: `oidcConfig` and
 * `samlConfig` hold the provider's configuration as JSON text (exactly one
 * of them is set, depending on the protocol), and `domain` is the email
 * domain whose users are routed to this provider.
 */
export const ssoProviders = pgTable("sso_provider", {
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull(),
    domain: text("domain").notNull(),
    providerId: text("provider_id").notNull().unique(),
    oidcConfig: text("oidc_config"),
    samlConfig: text("saml_config"),
    userId: varchar("user_id", { length: 128 }).references(() => users.id, {
        onDelete: "set null",
    }),
    organizationId: text("organization_id"),
});

export type SsoProvider = typeof ssoProviders.$inferSelect;
export type NewSsoProvider = typeof ssoProviders.$inferInsert;
