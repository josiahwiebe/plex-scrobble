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

type LoginJson = { result?: string | boolean; message?: string; csrf?: string }

function tryParseLoginResponse(text: string): LoginJson | null {
  const t = text.trim()
  if (!t.startsWith('{')) return null
  try {
    return JSON.parse(t) as LoginJson
  } catch {
    return null
  }
}

function isLoginJsonSuccess(json: LoginJson | null): boolean {
  if (!json) return false
  const r = json.result
  return r === true || r === 'success' || r === 'Success'
}

function isLoginJsonFailure(json: LoginJson | null): boolean {
  if (!json) return false
  const r = json.result
  return r === false || r === 'failure' || r === 'Failure'
}

function hasLetterboxdSessionCookies(cookies: { name: string; value: string }[]): boolean {
  return cookies.some((c) => c.name === 'com.xk72.webparts.csrf' && c.value.length > 0)
}

async function readLetterboxdCookies(page: BrowserPage): Promise<{ name: string; value: string }[]> {
  const cookieList = await page.cookies('https://letterboxd.com')
  return cookieList.map((c) => ({ name: c.name, value: c.value }))
}

async function waitForSessionCookies(page: BrowserPage, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (hasLetterboxdSessionCookies(await readLetterboxdCookies(page))) {
      return true
    }
    await sleep(400)
  }
  return false
}

/** Full-page Cloudflare interstitial — not Turnstile assets embedded on a normal sign-in page. */
function htmlLooksLikeCloudflareInterstitial(html: string): boolean {
  const hasSignInForm = html.includes('name="username"') && html.includes('name="password"')
  if (hasSignInForm) {
    return false
  }
  return (
    /just a moment/i.test(html) ||
    html.includes('cf-browser-verification') ||
    html.includes('challenge-platform')
  )
}

function htmlLooksLikeCloudflareChallenge(html: string): boolean {
  return htmlLooksLikeCloudflareInterstitial(html)
}

type BrowserPage = Awaited<ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>['newPage']>>

async function waitForSignInPage(page: BrowserPage): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const html = await page.content()
    if (!htmlLooksLikeCloudflareInterstitial(html)) {
      try {
        await page.waitForSelector('input[name="username"]', { timeout: 5000, visible: true })
        return
      } catch {
        /* still loading */
      }
    }
    await sleep(1500)
  }
  await page.waitForSelector('input[name="username"]', { timeout: 5000, visible: true })
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
      const userAgent =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      await page.setUserAgent(userAgent)
      await page.setViewport({ width: 1280, height: 800 })
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' })

      await page.goto('https://letterboxd.com/sign-in/', {
        waitUntil: 'networkidle2',
        timeout: 60000,
      })
      await waitForSignInPage(page)

      const signInHtml = await page.content()
      if (htmlLooksLikeCloudflareInterstitial(signInHtml)) {
        return Response.json(
          { error: 'Letterboxd sign-in page is behind a Cloudflare challenge (worker could not pass it)' },
          { status: 503 }
        )
      }

      const user = username.trim()

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

      let loginJson: LoginJson | null = null
      let loginHttpStatus: number | null = null
      try {
        const loginRes = await loginResponsePromise
        loginHttpStatus = loginRes.status()
        loginJson = tryParseLoginResponse(await loginRes.text())
      } catch {
        /* login.do timeout — may still have set cookies; validate below */
      }

      if (isLoginJsonFailure(loginJson)) {
        return Response.json(
          { error: loginJson!.message?.trim() || 'Letterboxd rejected username or password' },
          { status: 401 }
        )
      }

      const sessionFromLogin =
        isLoginJsonSuccess(loginJson) || (await waitForSessionCookies(page))

      if (sessionFromLogin) {
        const cookies = await readLetterboxdCookies(page)
        if (hasLetterboxdSessionCookies(cookies)) {
          return Response.json({ cookies })
        }
      }

      // Fallback: /settings/ works when login is email-based (no public profile slug).
      await page.goto('https://letterboxd.com/settings/', {
        waitUntil: 'networkidle2',
        timeout: 60000,
      })

      const pageUrl = page.url()
      if (pageUrl.includes('/sign-in')) {
        const hint = loginJson?.message?.trim()
        return Response.json(
          {
            error: hint
              ? `Login failed: ${hint}`
              : 'Login did not complete (redirected to sign-in)',
          },
          { status: 401 }
        )
      }

      const html = await page.content()
      if (htmlLooksLikeCloudflareChallenge(html)) {
        return Response.json(
          { error: 'Letterboxd settings page is behind a Cloudflare challenge after login' },
          { status: 503 }
        )
      }

      try {
        await page.waitForSelector('a[href*="sign-out"], [href*="/sign-out"]', { timeout: 12_000 })
      } catch {
        /* nav may use different markup; cookie check below is authoritative */
      }

      const cookies = await readLetterboxdCookies(page)
      if (hasLetterboxdSessionCookies(cookies)) {
        return Response.json({ cookies })
      }

      const looksLikeSignInForm =
        html.includes('name="username"') &&
        html.includes('name="password"') &&
        html.includes('/sign-in')
      const detail = [
        loginJson ? `login.do result=${String(loginJson.result)}` : 'login.do response not captured',
        loginHttpStatus != null ? `http=${loginHttpStatus}` : null,
        `url=${pageUrl}`,
        looksLikeSignInForm ? 'still on sign-in form' : 'settings page loaded without session cookies',
      ]
        .filter(Boolean)
        .join('; ')
      console.error('letterboxd-browser-worker login failed:', detail)
      return Response.json(
        {
          error: loginJson?.message?.trim() || `Login did not complete (${detail})`,
        },
        { status: 401 }
      )
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
