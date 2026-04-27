import puppeteer from '@cloudflare/puppeteer'

export interface Env {
  BROWSER: Fetcher
  LETTERBOXD_BROWSER_RENDERING_SECRET: string
}

function isLaunchRateLimitError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return (
    msg.includes('429') ||
    /rate limit exceeded/i.test(msg) ||
    /too many requests/i.test(msg) ||
    /browser time limit exceeded/i.test(msg)
  )
}

/** Cloudflare may attach status + headers on Puppeteer launch failures. */
function retryAfterMsFromError(e: unknown): number | null {
  if (e && typeof e === 'object' && 'status' in e && (e as { status: number }).status === 429) {
    const h = (e as { headers?: Headers }).headers
    const ra = h?.get?.('Retry-After')
    if (ra) {
      const secs = parseInt(ra, 10)
      if (!Number.isNaN(secs)) return secs * 1000
    }
  }
  return null
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

/**
 * Workers Free: about one new browser per 20s per account. Paid: ~1/sec.
 * Retries with backoff so double-clicks / webhook + test don't always fail.
 */
async function launchBrowserWithRetries(
  browserBinding: Env['BROWSER']
): Promise<Awaited<ReturnType<typeof puppeteer.launch>>> {
  const maxAttempts = 4
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await puppeteer.launch(browserBinding)
    } catch (e) {
      if (attempt === maxAttempts) {
        throw e
      }
      const fromHeader = retryAfterMsFromError(e)
      const rateLimited = isLaunchRateLimitError(e)
      if (!rateLimited && !fromHeader) {
        throw e
      }
      const waitMs =
        fromHeader ??
        (attempt === 1 ? 22_000 : Math.min(3000 * 2 ** (attempt - 2), 45_000))
      console.warn(
        `letterboxd-browser-worker puppeteer.launch failed (attempt ${attempt}/${maxAttempts}), waiting ${waitMs}ms before retry`
      )
      await sleep(waitMs)
    }
  }
  throw new Error('launchBrowserWithRetries: unreachable')
}

function tryParseLoginResponse(text: string): { result?: string | boolean; message?: string } | null {
  const t = text.trim()
  if (!t.startsWith('{')) return null
  try {
    return JSON.parse(t) as { result?: string | boolean; message?: string }
  } catch {
    return null
  }
}

function htmlLooksLikeCloudflareChallenge(html: string): boolean {
  return (
    html.includes('cf-turnstile') ||
    html.includes('challenge-platform') ||
    html.includes('cf-browser-verification') ||
    /just a moment/i.test(html)
  )
}

function responseForLaunchFailure(e: unknown): Response {
  const msg = e instanceof Error ? e.message : String(e)
  console.error('letterboxd-browser-worker', msg)
  if (isLaunchRateLimitError(e)) {
    return Response.json(
      {
        error:
          'Browser Run rate limit (429). Workers Free: about one new browser every 20 seconds and 10 minutes browser time per day. Upgrade to Workers Paid for much higher limits, or wait and retry.',
        code: 'BROWSER_RATE_LIMIT',
      },
      { status: 429, headers: { 'Retry-After': '20' } }
    )
  }
  return Response.json({ error: msg }, { status: 500 })
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
      browser = await launchBrowserWithRetries(env.BROWSER)
    } catch (e) {
      return responseForLaunchFailure(e)
    }

    try {
      const page = await browser.newPage()
      await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      )

      await page.goto('https://letterboxd.com/sign-in/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      })
      await page.waitForSelector('input[name="username"]', { timeout: 45000 })

      let signInHtml = await page.content()
      if (htmlLooksLikeCloudflareChallenge(signInHtml)) {
        return Response.json(
          { error: 'Letterboxd sign-in page is behind a Cloudflare challenge (worker could not pass it)' },
          { status: 503 }
        )
      }

      const user = username.trim()
      const profileSlug = user.toLowerCase()

      await page.click('input[name="username"]', { clickCount: 3 })
      await page.keyboard.press('Backspace')
      await page.type('input[name="username"]', user, { delay: 20 })
      await page.click('input[name="password"]', { clickCount: 3 })
      await page.keyboard.press('Backspace')
      await page.type('input[name="password"]', password, { delay: 20 })

      const loginResponsePromise = page.waitForResponse(
        (r) => r.url().includes('login.do') && r.request().method() === 'POST',
        { timeout: 45000 }
      )

      await page.click('button[type="submit"]')

      let loginJson: { result?: string | boolean; message?: string } | null = null
      try {
        const loginRes = await loginResponsePromise
        loginJson = tryParseLoginResponse(await loginRes.text())
      } catch {
        /* non-JSON or timeout — fall through to profile check */
      }

      if (loginJson?.result === 'failure' || loginJson?.result === false || loginJson?.result === 'Failure') {
        return Response.json(
          { error: loginJson.message?.trim() || 'Letterboxd rejected username or password' },
          { status: 401 }
        )
      }

      // Login is usually XHR + in-place DOM update; give the client bundle time to apply cookies / UI.
      await new Promise((r) => setTimeout(r, 4000))

      await page.goto(`https://letterboxd.com/${encodeURIComponent(profileSlug)}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      })

      try {
        await page.waitForSelector('[href*="sign-out"]', { timeout: 25000 })
      } catch {
        /* fall through to HTML heuristic */
      }

      const html = await page.content()
      if (htmlLooksLikeCloudflareChallenge(html)) {
        return Response.json(
          { error: 'Letterboxd profile page is behind a Cloudflare challenge after login' },
          { status: 503 }
        )
      }

      const signedIn =
        /sign\s*out/i.test(html) ||
        /\/sign-out\/?/i.test(html) ||
        (await page.$('[href*="sign-out"]')) !== null
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
