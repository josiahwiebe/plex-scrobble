import type { LetterboxdSessionCookie } from './schema.js'

/**
 * Optional Cloudflare Browser Rendering bridge: deploy the Worker in `workers/letterboxd-browser/`
 * and set the same secret on Vercel and the Worker. The main app stays on Vercel; only this HTTP
 * call hits Cloudflare.
 */
export async function letterboxdLoginViaBrowserRendering(
  username: string,
  password: string
): Promise<LetterboxdSessionCookie[] | null> {
  const url = process.env.LETTERBOXD_BROWSER_RENDERING_URL?.trim()
  const secret = process.env.LETTERBOXD_BROWSER_RENDERING_SECRET?.trim()
  if (!url || !secret) {
    return null
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ username, password }),
    })
  } catch (e) {
    console.error('Letterboxd browser rendering request failed:', e)
    return null
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.error('Letterboxd browser rendering:', res.status, text.slice(0, 500))
    return null
  }

  const data = (await res.json()) as { cookies?: LetterboxdSessionCookie[] }
  if (!data.cookies?.length) {
    return null
  }
  return data.cookies
}
