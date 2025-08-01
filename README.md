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
   # Fill in your configuration
   ```

3. **Configure database**
   ```bash
   bun run db:generate
   bun run db:migrate
   ```

4. **Start development server**
   ```bash
   bun run dev
   ```

## Environment Variables

- `DATABASE_URL` - PostgreSQL connection string (Supabase)
- `PLEX_CLIENT_ID` - Your Plex OAuth app client ID
- `PLEX_REDIRECT_URI` - OAuth redirect URI
- `ENCRYPTION_SECRET` - Secret for encrypting stored credentials

## How It Works

1. Connect your Plex account
2. Add your Letterboxd login credentials
3. Configure webhook in your Plex server settings
4. Watch movies on Plex - they'll automatically sync to Letterboxd

## Tech Stack

- **React Router v7** - Full-stack framework
- **TypeScript** - Type safety
- **Drizzle ORM** - Database management
- **PostgreSQL** - Database (via Supabase)
- **Puppeteer** - Web scraping for Letterboxd
- **TailwindCSS** - Styling with brutalist 90s aesthetic

## Requirements

- Node.js >=22.0.0
- PostgreSQL database
- Plex Media Server with webhook capability (requires Plex Pass)