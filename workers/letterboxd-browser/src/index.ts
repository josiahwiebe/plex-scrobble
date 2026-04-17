import puppeteer from '@cloudflare/puppeteer'

export interface Env {
  BROWSER: Fetcher
  LETTERBOXD_BROWSER_RENDERING_SECRET: string
}

/**
 * POST JSON `{ "username", "password" }` with `Authorization: Bearer <secret>`.
 * Returns `{ "cookies": [{ "name", "value" }] }` for the main Vercel app to merge into its Letterboxd session.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    const auth = request.headers.get('Authorization')
    const expected = `Bearer ${env.LETTERBOXD_BROWSER_RENDERING_SECRET}`
    if (!env.LETTERBOXD_BROWSER_RENDERING_SECRET || auth !== expected) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: { username?: string; password?: string }
    try {
      body = (await request.json()) as { username?: string; password?: string }
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const { username, password } = body
    if (!username || !password) {
      return Response.json({ error: 'username and password required' }, { status: 400 })
    }

    let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined
    try {
      browser = await puppeteer.launch(env.BROWSER)
      const page = await browser.newPage()
      await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      )

      await page.goto('https://letterboxd.com/sign-in/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      })
      await page.waitForSelector('input[name="username"]', { timeout: 45000 })
      await page.type('input[name="username"]', username, { delay: 15 })
      await page.type('input[name="password"]', password, { delay: 15 })

      await Promise.all([
        page.waitForResponse((r) => r.url().includes('login.do'), { timeout: 30000 }).catch(() => null),
        page.click('button[type="submit"]'),
      ])
      await new Promise((r) => setTimeout(r, 2500))

      await page.goto(`https://letterboxd.com/${encodeURIComponent(username)}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      })
      const html = await page.content()
      const signedIn = /sign\s*out/i.test(html) || /\/sign-out\//i.test(html)
      if (!signedIn) {
        return Response.json({ error: 'Login did not complete (profile check failed)' }, { status: 401 })
      }

      const cookieList = await page.cookies('https://letterboxd.com')
      const cookies = cookieList.map((c) => ({ name: c.name, value: c.value }))
      return Response.json({ cookies })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.error('letterboxd-browser-worker', message)
      return Response.json({ error: message }, { status: 500 })
    } finally {
      if (browser) {
        await browser.close()
      }
    }
  },
}
