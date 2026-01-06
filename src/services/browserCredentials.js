/**
 * Browser Credential Extraction Module
 * Automatically extracts HopGPT credentials by opening a browser session
 */
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';

const HOPGPT_URL = 'https://chat.ai.jh.edu';
const CHAT_API_ENDPOINT = '/api/agents/chat/AnthropicClaude';

puppeteer.use(StealthPlugin());

async function launchBrowser(options = {}) {
  const launchOptions = {
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized']
  };

  const userDataDir = options.userDataDir || process.env.HOPGPT_PUPPETEER_USER_DATA_DIR;
  if (userDataDir) {
    launchOptions.userDataDir = userDataDir;
  }

  const channel = options.channel || process.env.HOPGPT_PUPPETEER_CHANNEL || 'chrome';

  try {
    return await puppeteer.launch({ ...launchOptions, channel });
  } catch (error) {
    if (!options.channel && !process.env.HOPGPT_PUPPETEER_CHANNEL) {
      console.warn(`Failed to launch Chrome channel (${channel}). Falling back to bundled Chromium.`);
      return await puppeteer.launch(launchOptions);
    }

    throw error;
  }
}

/**
 * Extract credentials from a browser session
 * @param {object} options - Configuration options
 * @param {string} options.envPath - Path to write .env file (default: .env in project root)
 * @param {number} options.timeout - Timeout in ms to wait for login (default: 5 minutes)
 * @param {string} options.userDataDir - Chrome user data directory (optional)
 * @param {string} options.channel - Chrome release channel for Puppeteer (optional)
 * @returns {Promise<object>} Extracted credentials
 */
export async function extractCredentials(options = {}) {
  const envPath = options.envPath || path.join(process.cwd(), '.env');
  const timeout = options.timeout || 5 * 60 * 1000; // 5 minutes default

  console.log('\n=== HopGPT Browser Credential Extraction ===\n');
  console.log('Opening browser to HopGPT login page...');
  console.log('Please complete the login process in the browser window.\n');

  const browser = await launchBrowser(options);

  const page = await browser.newPage();

  // Store captured credentials
  const credentials = {
    bearerToken: null,
    cookies: {
      cf_clearance: null,
      connect_sid: null,
      __cf_bm: null,
      refreshToken: null,
      token_provider: null
    }
  };

  // Set up request interception to capture the bearer token
  await page.setRequestInterception(true);

  page.on('request', (request) => {
    const url = request.url();

    // Capture Authorization header from chat API requests
    if (url.includes(CHAT_API_ENDPOINT) || url.includes('/api/auth/')) {
      const authHeader = request.headers()['authorization'];
      if (authHeader && authHeader.startsWith('Bearer ')) {
        credentials.bearerToken = authHeader.replace('Bearer ', '');
        console.log('Captured bearer token from request');
      }
    }

    request.continue();
  });

  // Navigate to HopGPT
  await page.goto(HOPGPT_URL, { waitUntil: 'networkidle2' });

  console.log('Waiting for authentication...');
  console.log('(The page will automatically detect when you are logged in)\n');

  // Wait for successful authentication
  const startTime = Date.now();
  let authenticated = false;

  while (!authenticated && (Date.now() - startTime) < timeout) {
    // Check current cookies
    const cookies = await page.cookies();
    const cookieMap = {};
    for (const cookie of cookies) {
      cookieMap[cookie.name] = cookie.value;
    }

    // Check if we have the refresh token (indicates successful login)
    if (cookieMap['refreshToken']) {
      credentials.cookies.refreshToken = cookieMap['refreshToken'];
      credentials.cookies.cf_clearance = cookieMap['cf_clearance'] || null;
      credentials.cookies.connect_sid = cookieMap['connect.sid'] || null;
      credentials.cookies.__cf_bm = cookieMap['__cf_bm'] || null;
      credentials.cookies.token_provider = cookieMap['token_provider'] || 'librechat';

      console.log('Detected successful login!');
      authenticated = true;

      // If we don't have a bearer token yet, try to get one
      if (!credentials.bearerToken) {
        console.log('Attempting to capture bearer token...');

        // Try to trigger a token refresh or navigate to trigger an API call
        try {
          // Check if we're on the main chat page
          const currentUrl = page.url();
          if (currentUrl.includes('/c/') || currentUrl === HOPGPT_URL + '/' || currentUrl === HOPGPT_URL) {
            // Try refreshing tokens via the API
            const tokenResponse = await page.evaluate(async () => {
              try {
                const response = await fetch('/api/auth/refresh', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: '{}'
                });
                if (response.ok) {
                  const data = await response.json();
                  return data.token || null;
                }
              } catch (e) {
                return null;
              }
              return null;
            });

            if (tokenResponse) {
              credentials.bearerToken = tokenResponse;
              console.log('Captured bearer token via refresh endpoint');
            }
          }
        } catch (e) {
          // Ignore errors, bearer token is optional
        }
      }
    }

    if (!authenticated) {
      await new Promise(resolve => setTimeout(resolve, 1000)); // Poll every second
    }
  }

  if (!authenticated) {
    await browser.close();
    throw new Error(`Login timeout after ${timeout / 1000} seconds. Please try again.`);
  }

  // Get final cookie state
  const finalCookies = await page.cookies();
  for (const cookie of finalCookies) {
    if (cookie.name === 'cf_clearance') credentials.cookies.cf_clearance = cookie.value;
    if (cookie.name === 'connect.sid') credentials.cookies.connect_sid = cookie.value;
    if (cookie.name === '__cf_bm') credentials.cookies.__cf_bm = cookie.value;
    if (cookie.name === 'refreshToken') credentials.cookies.refreshToken = cookie.value;
    if (cookie.name === 'token_provider') credentials.cookies.token_provider = cookie.value;
  }

  await browser.close();
  console.log('\nBrowser closed.\n');

  // Generate .env content
  const envContent = generateEnvContent(credentials);

  // Write to .env file
  writeEnvFile(envPath, envContent);

  console.log('=== Credential Extraction Complete ===\n');
  console.log(`Credentials saved to: ${envPath}`);
  console.log('\nExtracted credentials:');
  console.log(`  - Bearer Token: ${credentials.bearerToken ? 'Yes' : 'No (will be refreshed automatically)'}`);
  console.log(`  - Refresh Token: ${credentials.cookies.refreshToken ? 'Yes' : 'No'}`);
  console.log(`  - CF Clearance: ${credentials.cookies.cf_clearance ? 'Yes' : 'No'}`);
  console.log(`  - Connect SID: ${credentials.cookies.connect_sid ? 'Yes' : 'No'}`);
  console.log(`  - CF BM: ${credentials.cookies.__cf_bm ? 'Yes' : 'No'}`);

  return credentials;
}

/**
 * Generate .env file content from credentials
 * @param {object} credentials - Extracted credentials
 * @returns {string} .env file content
 */
function generateEnvContent(credentials) {
  const lines = [
    '# HopGPT Credentials',
    '# Auto-generated by browser credential extraction',
    `# Generated at: ${new Date().toISOString()}`,
    ''
  ];

  if (credentials.bearerToken) {
    lines.push(`HOPGPT_BEARER_TOKEN=${credentials.bearerToken}`);
  } else {
    lines.push('# HOPGPT_BEARER_TOKEN= (will be auto-refreshed using refresh token)');
  }

  if (credentials.cookies.cf_clearance) {
    lines.push(`HOPGPT_COOKIE_CF_CLEARANCE=${credentials.cookies.cf_clearance}`);
  }

  if (credentials.cookies.connect_sid) {
    lines.push(`HOPGPT_COOKIE_CONNECT_SID=${credentials.cookies.connect_sid}`);
  }

  if (credentials.cookies.__cf_bm) {
    lines.push(`HOPGPT_COOKIE_CF_BM=${credentials.cookies.__cf_bm}`);
  }

  if (credentials.cookies.refreshToken) {
    lines.push(`HOPGPT_COOKIE_REFRESH_TOKEN=${credentials.cookies.refreshToken}`);
  }

  if (credentials.cookies.token_provider) {
    lines.push(`HOPGPT_COOKIE_TOKEN_PROVIDER=${credentials.cookies.token_provider}`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Write or update .env file, preserving non-HopGPT variables
 * @param {string} envPath - Path to .env file
 * @param {string} newContent - New credential content
 */
function writeEnvFile(envPath, newContent) {
  let existingContent = '';
  let preservedLines = [];

  // Read existing .env if it exists
  if (fs.existsSync(envPath)) {
    existingContent = fs.readFileSync(envPath, 'utf-8');

    // Preserve non-HopGPT lines
    const hopgptVars = [
      'HOPGPT_BEARER_TOKEN',
      'HOPGPT_COOKIE_CF_CLEARANCE',
      'HOPGPT_COOKIE_CONNECT_SID',
      'HOPGPT_COOKIE_CF_BM',
      'HOPGPT_COOKIE_REFRESH_TOKEN',
      'HOPGPT_COOKIE_TOKEN_PROVIDER'
    ];

    for (const line of existingContent.split('\n')) {
      const trimmed = line.trim();

      // Skip empty lines, comments about HopGPT, and HopGPT variables
      if (trimmed === '' || trimmed.startsWith('# HopGPT') || trimmed.startsWith('# Auto-generated') || trimmed.startsWith('# Generated at')) {
        continue;
      }

      const isHopgptVar = hopgptVars.some(v => trimmed.startsWith(v) || trimmed.startsWith(`# ${v}`));
      if (!isHopgptVar) {
        preservedLines.push(line);
      }
    }
  }

  // Combine preserved content with new credentials
  let finalContent = newContent;
  if (preservedLines.length > 0) {
    finalContent = newContent + '\n# Other configuration\n' + preservedLines.join('\n') + '\n';
  }

  fs.writeFileSync(envPath, finalContent);
}

export default { extractCredentials };
