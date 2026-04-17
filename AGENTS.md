# AGENTS.md - Coding Agent Guidelines

## Build/Test/Lint Commands

- Use `bun` for package management (bun.lock present)
- Node.js >=22.0.0 required
- Development: `bun run dev`. **Don't try to run this command as the user will run it themselves.**
- Build: `bun run build`
- Deploy: `bun run deploy` (Vercel — `vercel deploy`)
- Type checking: `bun run typecheck`
- Database migrations: `bun run db:generate`, `bun run db:migrate`, `bun run db:push`

## Project Structure

- React Router v7 framework mode webapp
- TypeScript project with ES modules (`"type": "module"`)
- App routes in `/app/routes/`
- Uses Drizzle ORM for database, cookie sessions for Plex auth

## Code Style Guidelines

- Use TypeScript with explicit interface definitions
- Import with `.js` extensions for ES modules (src/letterboxd-scraper.ts:2)
- Prefer async/await over promises
- Use private class properties with explicit typing
- Error handling with try/catch blocks and descriptive error messages
- Console.log for debugging and status updates
- Use optional chaining (`?.`) and nullish coalescing for safety
- Single quotes for strings, semicolons required
- Interfaces in PascalCase, variables in camelCase
- Export both classes and factory functions where appropriate

## Architecture

- React Router v7 in framework mode (https://reactrouter.com/home)
- Deploy to **Vercel** with `@vercel/react-router` (`vercelPreset` in `react-router.config.ts`)
- TailwindCSS v4 for styling
- Custom Plex OAuth for authentication
- Drizzle ORM with PostgreSQL (Supabase) — use pooler connection string in `DATABASE_URL` for serverless
- Webhook endpoint at `/webhook` and `/webhook/:token`; background cookie persistence via `@vercel/functions` `waitUntil`
- Letterboxd: fetch-based session (stored cookies in DB); optional Cloudflare Worker (`workers/letterboxd-browser/`) with Browser Rendering — set ` ` + `LETTERBOXD_BROWSER_RENDERING_SECRET` on Vercel to bridge challenges

## Database Schema

- Uses Drizzle ORM with PostgreSQL via Supabase
- Users table with plex_id, plex_token, letterboxd credentials, letterboxd_session_cookies (JSON)
- Store minimal data only (as requested)
- Schema defined in `app/lib/schema.ts`
- Database helpers in `app/lib/database.ts`
- Migrations in `/drizzle/` directory

## Visual Style

- Brutalist 90s web aesthetic with bold borders and bright colors
- Font-mono (Courier New) for retro feel
- Avoid shadcn/ui, use simple custom components
- High contrast, blocky buttons with thick black borders
