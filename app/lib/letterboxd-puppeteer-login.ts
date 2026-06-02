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

async function readCookies(page: PageInstance): Promise<LetterboxdSessionCookie[]> {
  const list = await page.cookies(LETTERBOXD_ORIGIN)
  return list.map((c: { name: string; value: string }) => ({ name: c.name, value: c.value }))
}

async function waitForCsrfCookie(page: PageInstance, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (hasCsrfCookie(await readCookies(page))) {
      return true
    }
    await sleep(500)
  }
  return false
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
  if (htmlLooksLikeCloudflareInterstitial(html)) {
    return null
  }

  try {
    await page.waitForSelector('a[href*="sign-out"], [href*="/sign-out"]', { timeout: 15_000 })
  } catch {
    /* markup varies; cookie jar is authoritative */
  }

  const cookies = await readCookies(page)
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

    const user = username.trim()
    const usernameSel = 'input[name="username"], input[name="email"], input[type="email"]'
    const passwordSel = 'input[name="password"], input[type="password"]'
    if (!(await page.$(usernameSel)) || !(await page.$(passwordSel))) {
      console.error('Letterboxd puppeteer: login fields not found', await page.url())
      return null
    }

    await page.click(usernameSel, { clickCount: 3 })
    await page.keyboard.press('Backspace')
    await page.type(usernameSel, user, { delay: 25 })
    await page.click(passwordSel, { clickCount: 3 })
    await page.keyboard.press('Backspace')
    await page.type(passwordSel, password, { delay: 25 })
    await randomDelay(400, 900)

    const loginResponsePromise = page.waitForResponse(
      (r: { url: () => string; request: () => { method: () => string } }) =>
        r.url().includes('login.do') && r.request().method() === 'POST',
      { timeout: 45_000 }
    )

    const navigationPromise = page
      .waitForNavigation({ waitUntil: 'networkidle2', timeout: 60_000 })
      .catch(() => null)

    await page.click('button[type="submit"], input[type="submit"]')

    let loginJson: LoginJson | null = null
    try {
      const loginRes = await loginResponsePromise
      loginJson = tryParseLoginResponse(await loginRes.text())
      if (loginJson?.csrf) {
        await page.setCookie({
          name: 'com.xk72.webparts.csrf',
          value: loginJson.csrf,
          domain: '.letterboxd.com',
          path: '/',
        })
      }
    } catch {
      /* login.do may not fire on serverless; validate via settings */
    }

    await navigationPromise

    if (isLoginJsonFailure(loginJson)) {
      console.error('Letterboxd puppeteer: login rejected:', loginJson?.message?.trim())
      return null
    }

    let cookies = await readCookies(page)
    if (hasMinimalLetterboxdSession(cookiesToJar(cookies))) {
      console.log('Letterboxd puppeteer: login succeeded (cookies on current page)')
      return cookies
    }

    if (isLoginJsonSuccess(loginJson) || (await waitForCsrfCookie(page))) {
      cookies = await readCookies(page)
      if (hasMinimalLetterboxdSession(cookiesToJar(cookies))) {
        console.log('Letterboxd puppeteer: login succeeded')
        return cookies
      }
    }

    console.log('Letterboxd puppeteer: confirming session via /settings/…')
    const settingsCookies = await confirmSessionViaSettings(page)
    if (settingsCookies) {
      console.log('Letterboxd puppeteer: login succeeded (settings)')
      return settingsCookies
    }

    const names = (await readCookies(page)).map((c) => c.name).join(', ')
    console.error(
      'Letterboxd puppeteer: no session after submit',
      loginJson?.message?.trim() || `cookies=[${names}] url=${await page.url()}`
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
