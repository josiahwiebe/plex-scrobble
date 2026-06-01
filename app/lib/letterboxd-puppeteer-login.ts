import type { LetterboxdSessionCookie } from './schema.js'

const CHROME_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BrowserInstance = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PageInstance = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ElementHandleInstance = any

type LoginJson = { result?: string | boolean; message?: string }

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

function hasSessionCookies(cookies: LetterboxdSessionCookie[]): boolean {
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
  page.setDefaultTimeout(45_000)
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
  })
}

async function waitForCloudflare(page: PageInstance, maxWaitMs = 45_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    const title = await page.title()
    const content = await page.content()
    const hasSignInForm = content.includes('name="username"') && content.includes('name="password"')
    const interstitial =
      !hasSignInForm &&
      (title.includes('Just a moment') ||
        title.includes('Attention Required') ||
        content.includes('cf-browser-verification') ||
        /just a moment/i.test(content))
    if (!interstitial) return
    console.log('Letterboxd puppeteer: waiting for Cloudflare interstitial…')
    await randomDelay(1500, 2500)
  }
  console.warn('Letterboxd puppeteer: Cloudflare interstitial did not clear in time')
}

async function humanType(element: ElementHandleInstance, text: string): Promise<void> {
  for (const char of text) {
    await element.type(char, { delay: 50 + Math.random() * 80 })
    if (Math.random() < 0.08) await randomDelay(80, 200)
  }
}

async function readCookies(page: PageInstance): Promise<LetterboxdSessionCookie[]> {
  const list = await page.cookies('https://letterboxd.com')
  return list.map((c: { name: string; value: string }) => ({ name: c.name, value: c.value }))
}

async function waitForSessionCookies(page: PageInstance, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (hasSessionCookies(await readCookies(page))) return true
    await sleep(400)
  }
  return false
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
    await page.goto('https://letterboxd.com/sign-in/', { waitUntil: 'networkidle2', timeout: 60_000 })
    await waitForCloudflare(page)
    await randomDelay(800, 1500)

    const usernameField =
      (await page.$('input[name="username"]')) ??
      (await page.$('input[name="email"]')) ??
      (await page.$('input[type="email"]'))
    const passwordField =
      (await page.$('input[name="password"]')) ?? (await page.$('input[type="password"]'))
    if (!usernameField || !passwordField) {
      console.error('Letterboxd puppeteer: login fields not found', await page.url())
      return null
    }

    await humanType(usernameField, username.trim())
    await randomDelay(300, 600)
    await humanType(passwordField, password)
    await randomDelay(400, 900)

    const loginResponsePromise = page.waitForResponse(
      (r: { url: () => string; request: () => { method: () => string } }) =>
        r.url().includes('login.do') && r.request().method() === 'POST',
      { timeout: 45_000 }
    )

    const submit =
      (await page.$('button[type="submit"]')) ?? (await page.$('input[type="submit"]'))
    if (!submit) {
      console.error('Letterboxd puppeteer: submit control not found')
      return null
    }
    await submit.click()

    let loginJson: LoginJson | null = null
    try {
      const loginRes = await loginResponsePromise
      loginJson = tryParseLoginResponse(await loginRes.text())
    } catch {
      /* XHR may not fire; rely on cookies */
    }

    if (isLoginJsonFailure(loginJson)) {
      console.error('Letterboxd puppeteer: login rejected:', loginJson?.message?.trim())
      return null
    }

    const ok =
      isLoginJsonSuccess(loginJson) || (await waitForSessionCookies(page))
    if (!ok) {
      console.error('Letterboxd puppeteer: no session cookies after submit', loginJson?.message?.trim())
      return null
    }

    const cookies = await readCookies(page)
    if (!hasSessionCookies(cookies)) {
      return null
    }

    console.log('Letterboxd puppeteer: login succeeded')
    return cookies
  } catch (e) {
    console.error('Letterboxd puppeteer login failed:', e)
    return null
  } finally {
    if (browser) {
      await browser.close().catch(() => {})
    }
  }
}
