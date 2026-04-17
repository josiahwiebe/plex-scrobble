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

## Billing

Browser Rendering is a paid Cloudflare capability; enable it on your account and review [Browser Rendering pricing](https://developers.cloudflare.com/browser-rendering/).
