import { createCookieSessionStorage } from "react-router";
import type { User } from "./schema.js";
import { getUserById } from "./database.js";

const { getSession, commitSession, destroySession } = createCookieSessionStorage({
  cookie: {
    name: "__plex_auth",
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
    sameSite: "lax",
    secrets: [process.env.SESSION_SECRET || "fallback-secret"],
    secure: process.env.NODE_ENV === "production",
  },
});

export { getSession, commitSession, destroySession };

export interface PlexPinData {
  pinId: number;
  code: string;
  createdAt: number;
}

export async function storePlexPin(request: Request, pinData: PlexPinData): Promise<string> {
  const session = await getSession(request.headers.get("Cookie"));
  session.set("plexPin", pinData);
  return commitSession(session, {
    maxAge: 60 * 10, // 10 minutes for PIN data
  });
}

export async function getPlexPin(request: Request): Promise<PlexPinData | null> {
  const session = await getSession(request.headers.get("Cookie"));
  return session.get("plexPin") || null;
}

export async function clearPlexPin(request: Request): Promise<string> {
  const session = await getSession(request.headers.get("Cookie"));
  session.unset("plexPin");
  return commitSession(session);
}

export async function createUserSession(user: User, request: Request): Promise<string> {
  const session = await getSession(request.headers.get("Cookie"));
  session.unset("plexPin");
  session.set("user", user);
  return commitSession(session);
}

export async function getUserFromSession(request: Request): Promise<User | null> {
  const session = await getSession(request.headers.get("Cookie"));
  const user = session.get("user");

  if (!user) {
    return null;
  }

  const dbUser = await getUserById(user.id);
  if (!dbUser) {
    return null;
  }

  return user;
}

export async function validateUserSession(request: Request): Promise<{ user: User | null; headers?: { "Set-Cookie": string } }> {
  const session = await getSession(request.headers.get("Cookie"));
  const user = session.get("user");

  if (!user) {
    return { user: null };
  }

  const dbUser = await getUserById(user.id);
  if (!dbUser) {
    const destroyedSessionCookie = await destroyUserSession(request);
    return {
      user: null,
      headers: { "Set-Cookie": destroyedSessionCookie }
    };
  }

  return { user };
}

export async function destroyUserSession(request: Request): Promise<string> {
  const session = await getSession(request.headers.get("Cookie"));
  return destroySession(session);
}