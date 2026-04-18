# Letterboxd browser login (Cloudflare Browser Rendering)

The main app runs on **Vercel**. Cloudflare **Browser Rendering** only works on Workers, so this is a tiny separate Worker: your Vercel app calls it over HTTPS when fetch-based Letterboxd login hits a Cloudflare challenge.

## Deploy

1. `cd workers/letterboxd-browser && bun install`
2. Create a long random secret; set it in both places:
   - `wrangler secret put LETTERBOXD_BROWSER_RENDERING_SECRET`
   - Same value in Vercel: `LETTERBOXD_BROWSER_RENDERING_SECRET`
3. `bun run deploy`
4. Copy the Worker URL (e.g. `https://plex-scrobble-letterboxd-browser.<subdomain>.workers.dev`) into Vercel as **`LETTERBOXD_BROWSER_RENDERING_URL`** (POST endpoint root — no path).

Local dev: copy `.dev.vars.example` to `.dev.vars` and run `bun run dev`.

## Rate limits (why you see `429`)

Browser Run enforces **per-account** limits on **new browser instances**. On **Workers Free** that is roughly **one new browser every 20 seconds** and **10 minutes of browser time per day** — easy to hit if you spam “test login” or overlap with webhooks. **Workers Paid** is much looser (see [limits](https://developers.cloudflare.com/browser-rendering/platform/limits/)).

This Worker **retries** `puppeteer.launch` with backoff and returns HTTP **429** with `Retry-After` when still throttled; the Vercel app **retries the HTTP call** a few times after `Retry-After`.

## Billing

Enable Browser Rendering on your account and review [Browser Run pricing](https://developers.cloudflare.com/browser-run/pricing/).
