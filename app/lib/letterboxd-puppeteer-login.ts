import type { LetterboxdSessionCookie } from './schema.js'
import { hasMinimalLetterboxdSession } from './letterboxd-parse.js'

const CHROME_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const LETTERBOXD_ORIGIN = 'https://letterboxd.com'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BrowserInstance = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PageInstance = any

type LoginJson = { result?: string | boolean; message?: string; csrf?: string }

type PageLoginResult = {
  ok: boolean
  status: number
  json: LoginJson | null
  error?: string
}

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

function cookiesToJar(cookies: LetterboxdSessionCookie[]): Map<string, string> {
  return new Map(cookies.map((c) => [c.name, c.value]))
}

function hasCsrfCookie(cookies: LetterboxdSessionCookie[]): boolean {
  return cookies.some((c) => c.name === 'com.xk72.webparts.csrf' && c.value.length > 0)
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

async function randomDelay(minMs = 500, maxMs = 1500): Promise<void> {
  await sleep(minMs + Math.random() * (maxMs - minMs))
}

async function launchBrowser(): Promise<BrowserInstance> {
  const isVercel = !!process.env.VERCEL_ENV
  const baseArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--window-size=1920,1080',
  ]

  if (isVercel) {
    const chromium = (await import('@sparticuz/chromium')).default
    const puppeteerCore = await import('puppeteer-core')
    return puppeteerCore.launch({
      args: [...chromium.args, ...baseArgs],
      defaultViewport: { width: 1920, height: 1080 },
      executablePath: await chromium.executablePath(),
      headless: true,
    })
  }

  const puppeteerExtra = (await import('puppeteer-extra')).default
  const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default
  puppeteerExtra.use(StealthPlugin())
  return puppeteerExtra.launch({
    headless: true,
    args: baseArgs,
  })
}

async function preparePage(page: PageInstance): Promise<void> {
  await page.setUserAgent(CHROME_USER_AGENT)
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' })
  page.setDefaultTimeout(60_000)
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
  })
}

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

function htmlLooksAuthed(html: string): boolean {
  const hasSignOut =
    /sign\s*out/i.test(html) || /\/sign-out\/?/i.test(html) || /href="[^"]*sign-out/i.test(html)
  const onLoginForm =
    html.includes('name="password"') &&
    html.includes('name="username"') &&
    (html.includes('/sign-in') || html.includes('Sign in to continue'))
  return hasSignOut && !onLoginForm
}

async function waitForCloudflare(page: PageInstance, maxWaitMs = 45_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    const title = await page.title()
    const content = await page.content()
    if (!htmlLooksLikeCloudflareInterstitial(content) && !title.includes('Just a moment')) {
      return
    }
    console.log('Letterboxd puppeteer: waiting for Cloudflare interstitial…')
    await randomDelay(1500, 2500)
  }
  console.warn('Letterboxd puppeteer: Cloudflare interstitial did not clear in time')
}

/** All letterboxd.com cookies (including HttpOnly session cookies). */
async function readLetterboxdCookies(page: PageInstance): Promise<LetterboxdSessionCookie[]> {
  const list = await page.cookies()
  return list
    .filter((c: { domain?: string }) => c.domain?.includes('letterboxd.com'))
    .map((c: { name: string; value: string }) => ({ name: c.name, value: c.value }))
}

async function waitForMinimalSession(page: PageInstance, timeoutMs = 35_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (hasMinimalLetterboxdSession(cookiesToJar(await readLetterboxdCookies(page)))) {
      return true
    }
    await sleep(500)
  }
  return false
}

/**
 * POST /user/login.do from the page JS context (same cookies as a real browser submit).
 * More reliable than clicking submit on Vercel Chromium.
 */
async function postLoginFromPage(
  page: PageInstance,
  username: string,
  password: string
): Promise<PageLoginResult> {
  return page.evaluate(
    async (user: string, pass: string) => {
      const readCsrf = () => {
        const match = document.cookie
          .split('; ')
          .find((c) => c.startsWith('com.xk72.webparts.csrf='))
        return match ? decodeURIComponent(match.split('=').slice(1).join('=')) : null
      }

      const csrf = readCsrf()
      if (!csrf) {
        return { ok: false, status: 0, json: null, error: 'missing_csrf_cookie' }
      }

      const body = new URLSearchParams({
        __csrf: csrf,
        username: user,
        password: pass,
        remember: 'true',
      })

      try {
        const res = await fetch('/user/login.do', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Accept: 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: body.toString(),
          credentials: 'include',
        })
        const text = await res.text()
        let json: LoginJson | null = null
        if (text.trim().startsWith('{')) {
          try {
            json = JSON.parse(text) as LoginJson
          } catch {
            json = null
          }
        }
        return { ok: res.ok, status: res.status, json }
      } catch (e) {
        return {
          ok: false,
          status: 0,
          json: null,
          error: e instanceof Error ? e.message : String(e),
        }
      }
    },
    username.trim(),
    password
  )
}

async function confirmSessionViaSettings(page: PageInstance): Promise<LetterboxdSessionCookie[] | null> {
  await page.goto(`${LETTERBOXD_ORIGIN}/settings/`, {
    waitUntil: 'networkidle2',
    timeout: 60_000,
  })

  const pageUrl = page.url()
  if (pageUrl.includes('/sign-in')) {
    return null
  }

  const html = await page.content()
  if (htmlLooksLikeCloudflareInterstitial(html) || !htmlLooksAuthed(html)) {
    return null
  }

  const cookies = await readLetterboxdCookies(page)
  return hasMinimalLetterboxdSession(cookiesToJar(cookies)) ? cookies : null
}

/**
 * Headless login via Puppeteer (@sparticuz/chromium on Vercel, stealth locally).
 * Used when fetch-based login hits Cloudflare or stale cookies.
 */
export async function letterboxdLoginViaPuppeteer(
  username: string,
  password: string
): Promise<LetterboxdSessionCookie[] | null> {
  let browser: BrowserInstance | null = null
  try {
    browser = await launchBrowser()
    const page = await browser.newPage()
    await preparePage(page)

    console.log('Letterboxd puppeteer: opening sign-in…')
    await page.goto(`${LETTERBOXD_ORIGIN}/sign-in/`, { waitUntil: 'networkidle2', timeout: 60_000 })
    await waitForCloudflare(page)
    await randomDelay(800, 1500)

    const signInHtml = await page.content()
    if (htmlLooksLikeCloudflareInterstitial(signInHtml)) {
      console.error('Letterboxd puppeteer: sign-in blocked by Cloudflare')
      return null
    }

    console.log('Letterboxd puppeteer: posting login.do from browser context…')
    const pageLogin = await postLoginFromPage(page, username, password)

    if (isLoginJsonFailure(pageLogin.json)) {
      console.error(
        'Letterboxd puppeteer: login rejected:',
        pageLogin.json?.message?.trim() || pageLogin.error || `http=${pageLogin.status}`
      )
      return null
    }

    if (!isLoginJsonSuccess(pageLogin.json) && !pageLogin.ok) {
      console.warn(
        'Letterboxd puppeteer: login.do unexpected response',
        pageLogin.error || `http=${pageLogin.status}`,
        pageLogin.json?.message?.trim()
      )
    }

    if (await waitForMinimalSession(page)) {
      const cookies = await readLetterboxdCookies(page)
      console.log('Letterboxd puppeteer: login succeeded (in-page fetch)')
      return cookies
    }

    // Fallback: form submit (some environments block evaluate fetch)
    const usernameSel = 'input[name="username"], input[name="email"], input[type="email"]'
    const passwordSel = 'input[name="password"], input[type="password"]'
    if ((await page.$(usernameSel)) && (await page.$(passwordSel))) {
      console.log('Letterboxd puppeteer: retrying via form submit…')
      const user = username.trim()
      await page.click(usernameSel, { clickCount: 3 })
      await page.keyboard.press('Backspace')
      await page.type(usernameSel, user, { delay: 25 })
      await page.click(passwordSel, { clickCount: 3 })
      await page.keyboard.press('Backspace')
      await page.type(passwordSel, password, { delay: 25 })
      await page.click('button[type="submit"], input[type="submit"]')
      await waitForMinimalSession(page, 25_000)
      const cookies = await readLetterboxdCookies(page)
      if (hasMinimalLetterboxdSession(cookiesToJar(cookies))) {
        console.log('Letterboxd puppeteer: login succeeded (form)')
        return cookies
      }
    }

    console.log('Letterboxd puppeteer: confirming session via /settings/…')
    const settingsCookies = await confirmSessionViaSettings(page)
    if (settingsCookies) {
      console.log('Letterboxd puppeteer: login succeeded (settings)')
      return settingsCookies
    }

    const partial = await readLetterboxdCookies(page)
    const names = partial.map((c) => c.name).join(', ')
    const hasCf = partial.some((c) => c.name === 'cf_clearance')
    if (hasCf && hasCsrfCookie(partial)) {
      console.warn(
        'Letterboxd puppeteer: no user session cookie; returning Cloudflare cookies for fetch login retry',
        pageLogin.json?.message?.trim() || `cookies=[${names}] login.do=${pageLogin.status}`
      )
      return partial
    }

    console.error(
      'Letterboxd puppeteer: no authenticated session',
      pageLogin.json?.message?.trim() ||
        `cookies=[${names}] url=${await page.url()} login.do=${pageLogin.status}`
    )
    return null
  } catch (e) {
    console.error('Letterboxd puppeteer login failed:', e)
    return null
  } finally {
    if (browser) {
      await browser.close().catch(() => {})
    }
  }
}
