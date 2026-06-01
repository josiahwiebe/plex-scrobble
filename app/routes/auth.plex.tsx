import type { LoaderFunctionArgs } from 'react-router'
import { redirectDocument } from 'react-router'
import { getPlexAuthUrl } from '../lib/auth.js'

/**
 * Starts Plex OAuth. Must use `redirectDocument` — a client-side navigation would
 * fetch this loader as JSON and follow the external Plex URL, parsing HTML as JSON.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const { authUrl, sessionCookie } = await getPlexAuthUrl(request)

  return redirectDocument(authUrl, {
    headers: {
      'Set-Cookie': sessionCookie,
    },
  })
}
