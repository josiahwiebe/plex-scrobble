import type { LetterboxdSessionCookie } from './schema.js'

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

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

  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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

    if (res.status === 429 && attempt < maxAttempts) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '20', 10)
      const waitMs = Math.min(1000 * (Number.isNaN(retryAfter) ? 20 : retryAfter), 120_000)
      console.warn(`Letterboxd browser rendering 429, retry after ${waitMs}ms (${attempt}/${maxAttempts})`)
      await sleep(waitMs)
      continue
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let detail = text.slice(0, 500)
      try {
        const parsed = JSON.parse(text) as { error?: string }
        if (parsed?.error) detail = parsed.error
      } catch {
        /* keep raw slice */
      }
      console.error('Letterboxd browser rendering:', res.status, detail)
      return null
    }

    const data = (await res.json()) as { cookies?: LetterboxdSessionCookie[] }
    if (!data.cookies?.length) {
      return null
    }
    return data.cookies
  }

  return null
}
