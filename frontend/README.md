# Frontend React (A1-001)

React + TypeScript + Vite bootstrap for the Kanban UI.

## Setup

```bash
# from repo root, keep a single shared .env:
# cp .env.example .env
npm install
npm run dev
```

## Env

- `VITE_API_BASE_URL` - Base URL for backend API requests.
  - Example: `http://localhost:8080`
  - Loaded from root `.env` (`../.env`) via `vite.config.ts` `envDir: '..'`

## Scripts

- `npm run dev` - Start Vite dev server
- `npm run build` - TypeScript project build + Vite production build
- `npm run typecheck` - TypeScript project checks
- `npm run lint` - ESLint checks
- `npm run format` - Prettier write
- `npm run format:check` - Prettier check
