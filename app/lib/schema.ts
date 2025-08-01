import { pgTable, text, timestamp, uuid, integer, jsonb } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  plexId: text("plex_id").unique(),
  plexUsername: text("plex_username"),
  plexToken: text("plex_token"),
  letterboxdUsername: text("letterboxd_username"),
  letterboxdPasswordHash: text("letterboxd_password_hash"),
  letterboxdPasswordSalt: text("letterboxd_password_salt"),
  webhookSettings: jsonb("webhook_settings").$type<WebhookSettings>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const plexPins = pgTable("plex_pins", {
  id: uuid("id").defaultRandom().primaryKey(),
  pinId: integer("pin_id").notNull(),
  code: text("code").unique().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export interface WebhookSettings {
  enabled: boolean;
  events: {
    scrobble: boolean; // Mark as watched
    rate: boolean; // Rating changes
  };
  onlyMovies: boolean; // Skip TV shows
}

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type PlexPin = typeof plexPins.$inferSelect;
export type NewPlexPin = typeof plexPins.$inferInsert;