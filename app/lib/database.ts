import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, and, gt, lt } from "drizzle-orm";
import { users, plexPins, type User, type NewUser, type PlexPin } from "./schema.js";

const connectionString = process.env.DATABASE_URL!;
const client = postgres(connectionString, { prepare: false });
export const db = drizzle(client);

export async function createUser(data: NewUser): Promise<User> {
  const [user] = await db.insert(users).values(data).returning();
  return user;
}

export async function getUserByPlexId(plexId: string): Promise<User | null> {
  const [user] = await db.select().from(users).where(eq(users.plexId, plexId));
  return user || null;
}

export async function updateUser(id: string, data: Partial<User>): Promise<User> {
  const [user] = await db
    .update(users)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning();
  return user;
}

export async function getUserById(id: string): Promise<User | null> {
  const [user] = await db.select().from(users).where(eq(users.id, id));
  return user || null;
}

export async function getPlexPinByCode(code: string): Promise<PlexPin | null> {
  const [pin] = await db
    .select()
    .from(plexPins)
    .where(and(
      eq(plexPins.code, code),
      gt(plexPins.expiresAt, new Date())
    ));
  return pin || null;
}

export async function getPlexPinById(pinId: number): Promise<PlexPin | null> {
  const [pin] = await db
    .select()
    .from(plexPins)
    .where(and(
      eq(plexPins.pinId, pinId),
      gt(plexPins.expiresAt, new Date())
    ));
  return pin || null;
}

export async function deletePlexPin(code: string): Promise<void> {
  await db.delete(plexPins).where(eq(plexPins.code, code));
}

export async function deleteExpiredPlexPins(): Promise<void> {
  await db.delete(plexPins).where(lt(plexPins.expiresAt, new Date()));
}