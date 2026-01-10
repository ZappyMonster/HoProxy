# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains the Express server and core proxy logic.
- `src/routes/` holds API endpoints like `messages.js`, `models.js`, and `refreshToken.js`.
- `src/services/` encapsulates HopGPT client behavior, browser credential extraction, TLS helpers, and conversation storage.
- `src/transformers/` maps request/response payloads between Anthropic and HopGPT.
- `src/utils/` includes helpers such as model mapping and SSE parsing.
- `test/` mirrors source areas with `routes/`, `services/`, `transformers/`, plus `fixtures/` and `helpers/`.

## Build, Test, and Development Commands
- `npm install` installs dependencies.
- `npm start` runs the proxy server (`http://localhost:3001` by default).
- `npm run dev` runs the server with auto-reload.
- `npm run extract` launches a browser to capture HopGPT credentials into `.env`.
- `npm test` runs the Vitest suite once.
- `npm run test:watch` runs Vitest in watch mode.

## Coding Style & Naming Conventions
- Use Node.js 18+ with ES modules (`import`/`export`).
- Follow the existing 2-space indentation and semicolon usage.
- Prefer `camelCase` for functions/variables and concise module names like `hopgptClient.js`.
- Keep route handlers in `src/routes/` and shared logic in `src/services/` or `src/utils/`.

## Testing Guidelines
- Tests are written with Vitest and Supertest.
- Place new tests under `test/` and name them `*.test.js` (e.g., `test/routes/messages.test.js`).
- Use `test/fixtures/` for request/response samples and `test/helpers/` for shared test utilities.
- Run a specific file with `npx vitest test/routes/messages.test.js`.

## Commit & Pull Request Guidelines
- Commit messages in this repo are short, imperative, and plain (e.g., “Update tests”).
- Keep commits focused; avoid mixing refactors with behavior changes.
- PRs should include a brief summary, testing notes (`npm test` or targeted tests), and any new env vars.

## Security & Configuration Tips
- Credentials live in `.env`; never commit tokens or cookies.
- Minimum required config is `HOPGPT_COOKIE_REFRESH_TOKEN`; other values can be extracted with `npm run extract`.

## Agent-Specific Instructions
- Use Context7 MCP docs when generating code, setup/config steps, or library/API guidance.
