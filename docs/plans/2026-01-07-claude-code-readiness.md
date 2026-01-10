# Claude Code Readiness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make HoProxy usable in Claude Code by documenting the workflow, keeping secrets out of git, and verifying local + Claude Code connectivity.

**Architecture:** The proxy remains a Node/Express server that forwards Anthropic-compatible requests to HopGPT. Readiness work focuses on documentation, repo hygiene, and a repeatable smoke-test workflow rather than changing proxy behavior.

**Tech Stack:** Node.js 18+, Express, Vitest, Puppeteer, node-tls-client.

### Task 1: Populate `CLAUDE.md` with a Claude Code runbook

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Write the file content**

```markdown
# HoProxy (Claude Code)

This repository is a Node/Express proxy that exposes Anthropic-compatible endpoints and forwards requests to HopGPT.

## Quickstart

```bash
npm install
npm run extract
npm start
```

The proxy listens on `http://localhost:3001` by default. Set `PORT` to change it.

## Claude Code configuration

Set either `~/.claude/settings.json` or shell environment variables to point Claude Code at the local proxy:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://localhost:3001",
    "ANTHROPIC_MODEL": "claude-sonnet-4-5-thinking"
  }
}
```

## Required environment variables

- `HOPGPT_COOKIE_REFRESH_TOKEN` (required for auto-refresh)
- `HOPGPT_USER_AGENT` (recommended to satisfy Cloudflare)
- Optional: `HOPGPT_BEARER_TOKEN`, `HOPGPT_COOKIE_CF_CLEARANCE`, `HOPGPT_COOKIE_CONNECT_SID`, `HOPGPT_COOKIE_CF_BM`, `HOPGPT_COOKIE_TOKEN_PROVIDER`

Run `npm run extract` to create/update `.env`.

## Smoke checks

```bash
curl http://localhost:3001/health
curl http://localhost:3001/v1/models
```

## Tests

```bash
npm test
```

## Troubleshooting

- 401/403 from HopGPT: re-run `npm run extract` and restart the server.
- Cloudflare challenge: ensure `HOPGPT_USER_AGENT` and clearance cookies exist.
```

**Step 2: Verify the section headers exist**

Run: `rg -n "Quickstart|Claude Code configuration|Smoke checks" CLAUDE.md`
Expected: Matches all three headings.

**Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add Claude Code runbook"
```

### Task 2: Add a `.gitignore` for secrets and build artifacts

**Files:**
- Create: `.gitignore`

**Step 1: Write the file content**

```gitignore
node_modules/
.env
.DS_Store
*.log
logs/
coverage/
chat.ai.jh.edu_Archive*.har
```

**Step 2: Verify git sees no secret files**

Run: `git status -s`
Expected: `.env` is not listed after reloading git ignore rules.

**Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: add gitignore for local artifacts"
```

### Task 3: Add a `.env.example` template for HopGPT credentials

**Files:**
- Create: `.env.example`

**Step 1: Write the file content**

```bash
PORT=3001
CONVERSATION_TTL_MS=21600000
HOPGPT_COOKIE_REFRESH_TOKEN=
HOPGPT_BEARER_TOKEN=
HOPGPT_USER_AGENT=
HOPGPT_COOKIE_CF_CLEARANCE=
HOPGPT_COOKIE_CONNECT_SID=
HOPGPT_COOKIE_CF_BM=
HOPGPT_COOKIE_TOKEN_PROVIDER=librechat
HOPGPT_PUPPETEER_CHANNEL=chrome
HOPGPT_PUPPETEER_USER_DATA_DIR=
```

**Step 2: Verify no secrets are included**

Run: `rg -n "HOPGPT_" .env.example`
Expected: Only empty values or placeholders.

**Step 3: Commit**

```bash
git add .env.example
git commit -m "docs: add env example for HopGPT"
```

### Task 4: Quarantine or remove the HAR capture file

**Files:**
- Modify/Delete: `chat.ai.jh.edu_Archive [26-01-03 11-14-17].har`

**Step 1: Decide whether the HAR is needed**

If it is not required, delete it.

```bash
rm "chat.ai.jh.edu_Archive [26-01-03 11-14-17].har"
```

If it is required for reference, move it to a safer location and redact any tokens/cookies first.

```bash
mkdir -p docs/fixtures
mv "chat.ai.jh.edu_Archive [26-01-03 11-14-17].har" docs/fixtures/
```

**Step 2: Commit**

```bash
git add -A
git commit -m "chore: remove or quarantine HAR capture"
```

### Task 5: Verify local setup and proxy endpoints

**Files:**
- None

**Step 1: Install dependencies**

Run: `npm install`
Expected: Install completes without errors.

**Step 2: Extract HopGPT credentials**

Run: `npm run extract`
Expected: `.env` created with HopGPT values and success message.

**Step 3: Start the server**

Run: `npm start`
Expected: Console shows the server banner with port 3001.

**Step 4: Smoke test endpoints**

Run:

```bash
curl http://localhost:3001/health
curl http://localhost:3001/v1/models
```

Expected: `health` returns JSON with `status: ok` and models list is returned.

### Task 6: Verify Claude Code can talk to the proxy

**Files:**
- Modify: `~/.claude/settings.json` (or set env vars in shell)

**Step 1: Point Claude Code at the proxy**

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://localhost:3001",
    "ANTHROPIC_MODEL": "claude-sonnet-4-5-thinking"
  }
}
```

**Step 2: Run a Claude Code request**

Run: `claude "Say hello"`
Expected: Response is returned and proxy logs show a `/v1/messages` request.

**Step 3: (Optional) Run unit tests**

Run: `npm test`
Expected: All tests pass.
