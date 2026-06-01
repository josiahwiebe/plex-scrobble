import type { Config } from '@react-router/dev/config'
import { vercelPreset } from '@vercel/react-router/vite'

export default {
  ssr: true,
  // Home is auth-dependent; prerendering it caused hydration mismatches after login.
  presets: [vercelPreset()],
} satisfies Config
