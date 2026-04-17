# Plex Letterboxd Scrobbler

Automatically sync your Plex movie watches to Letterboxd.

## Features

- **Plex Auth Integration** - Secure connection to your Plex account
- **Letterboxd Auto-Sync** - Automatically mark movies as watched on Letterboxd
- **Webhook Support** - Real-time syncing via Plex webhooks

## Quick Start

1. **Install dependencies**
   ```bash
   bun install
   ```

2. **Setup environment variables**
   ```bash
   cp .env.example .env
   # Fill in your configuration (see below)
   ```

3. **Configure database**
   ```bash
   bun run db:migrate
   ```

4. **Start development server**
   ```bash
   bun run dev
   ```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string (Supabase pooler works well for serverless) |
| `PLEX_CLIENT_ID` | Plex OAuth app client ID |
| `PLEX_REDIRECT_URI` | OAuth redirect URI (must match your deployed origin) |
| `ENCRYPTION_SECRET` | Encrypts stored Letterboxd password |
| `SESSION_SECRET` | Signed cookie secret for Plex session |
| `TELEGRAM_BOT_TOKEN` | Optional Telegram notifications |
| `TELEGRAM_CHAT_ID` | Optional Telegram chat id |

Production: set these in the Vercel project (or `.env` locally).

## Letterboxd

- Login uses **HTTP** (CSRF + `/user/login.do`). Film matching prefers **IMDb/TMDB** redirect URLs when Plex provides those GUIDs.
- Session cookies are persisted in the database for webhooks. If Letterboxd serves a Cloudflare challenge to plain `fetch`, login may fail until the challenge clears (no headless browser on Vercel by default).

## Deploy (Vercel)

```bash
bun run build
bun run deploy
```

Or connect the repo in the Vercel dashboard. Set `PLEX_REDIRECT_URI` to your production origin in Plex developer settings and in Vercel env.

Point your Plex webhook at `https://<your-host>/webhook/<token>` (or `/webhook` if using account matching).

## How It Works

1. Connect your Plex account
2. Add your Letterboxd login credentials (session cookies are stored after a successful login test)
3. Configure webhook in your Plex server settings
4. Watch movies on Plex - they'll automatically sync to Letterboxd

## Tech Stack

- **React Router v7** - Full-stack framework
- **TypeScript** - Type safety
- **Drizzle ORM** - Database management
- **PostgreSQL** - Database (via Supabase)
- **Vercel** - Hosting (`@vercel/react-router`)
- **TailwindCSS** - Styling with brutalist 90s aesthetic

## Requirements

- Node.js >=22.0.0 / Bun
- PostgreSQL database (Supabase recommended)
- Plex Media Server with webhook capability (requires Plex Pass)
