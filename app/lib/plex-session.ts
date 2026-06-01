import { createCookieSessionStorage } from 'react-router'
import type { User } from './schema.js'
import { getUserById } from './database.js'

const { getSession, commitSession, destroySession } = createCookieSessionStorage({
  cookie: {
    name: '__plex_auth',
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 30,
    path: '/',
    sameSite: 'lax',
    secrets: [process.env.SESSION_SECRET || 'fallback-secret'],
    secure: process.env.NODE_ENV === 'production',
  },
})

export { getSession, commitSession, destroySession }

export interface PlexPinData {
  pinId: number
  code: string
  createdAt: number
}

export async function storePlexPin(request: Request, pinData: PlexPinData): Promise<string> {
  const session = await getSession(request.headers.get('Cookie'))
  // Drop legacy full-user blob so the PIN cookie fits (4KB limit).
  session.unset('user')
  session.set('plexPin', pinData)
  return commitSession(session, {
    maxAge: 60 * 10, // 10 minutes for PIN data
  })
}

export async function getPlexPin(request: Request): Promise<PlexPinData | null> {
  const session = await getSession(request.headers.get('Cookie'))
  return session.get('plexPin') || null
}

export async function clearPlexPin(request: Request): Promise<string> {
  const session = await getSession(request.headers.get('Cookie'))
  session.unset('plexPin')
  return commitSession(session)
}

/** Resolves user id from session (current `userId` key or legacy full `user` blob). */
function getSessionUserId(session: Awaited<ReturnType<typeof getSession>>): string | null {
  const userId = session.get('userId') as string | undefined
  if (userId) {
    return userId
  }

  const legacyUser = session.get('user') as User | undefined
  return legacyUser?.id ?? null
}

export async function createUserSession(user: User, request: Request): Promise<string> {
  const session = await getSession(request.headers.get('Cookie'))
  session.unset('plexPin')
  session.unset('user')
  session.set('userId', user.id)
  return commitSession(session)
}

export async function getUserFromSession(request: Request): Promise<User | null> {
  const session = await getSession(request.headers.get('Cookie'))
  const userId = getSessionUserId(session)

  if (!userId) {
    return null
  }

  return getUserById(userId)
}

export async function validateUserSession(
  request: Request
): Promise<{ user: User | null; headers?: { 'Set-Cookie': string } }> {
  const session = await getSession(request.headers.get('Cookie'))
  const userId = getSessionUserId(session)

  if (!userId) {
    return { user: null }
  }

  const dbUser = await getUserById(userId)
  if (!dbUser) {
    const destroyedSessionCookie = await destroyUserSession(request)
    return {
      user: null,
      headers: { 'Set-Cookie': destroyedSessionCookie },
    }
  }

  // Migrate legacy sessions that stored the full user row (can exceed cookie size).
  if (session.get('user')) {
    session.unset('user')
    session.set('userId', dbUser.id)
    const sessionCookie = await commitSession(session)
    return { user: dbUser, headers: { 'Set-Cookie': sessionCookie } }
  }

  return { user: dbUser }
}

export async function destroyUserSession(request: Request): Promise<string> {
  const session = await getSession(request.headers.get('Cookie'))
  return destroySession(session)
}
