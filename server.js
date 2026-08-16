const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cheerio = require('cheerio');
const compression = require('compression');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const apicache = require('apicache');

require('dotenv').config()

// Configuration
const PORT = process.env.PORT || 3000;
const TARGET_URL = 'https://seznam-autobusu.cz';
const DEFAULT_COOKIE_SECRET = 'seznam-proxy-secret-key';
const COOKIE_SECRET = process.env.COOKIE_SECRET || DEFAULT_COOKIE_SECRET;
const WARNING_COOKIE = 'seznam_proxy_warned';
const SESSION_COOKIE = 'seznam_proxy_session_id';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const IS_TEST = process.env.NODE_ENV === 'test';

// Simple leveled/timestamped logger
function log(level, ...args) {
  const ts = new Date().toISOString();
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[${ts}] [${level.toUpperCase()}]`, ...args);
}

// Validate critical environment configuration at startup
function validateEnv() {
  const usesDefaultSecret = !process.env.COOKIE_SECRET ||
    process.env.COOKIE_SECRET === DEFAULT_COOKIE_SECRET ||
    process.env.COOKIE_SECRET === 'your-secret-key-here-change-me';

  if (usesDefaultSecret) {
    if (IS_PRODUCTION) {
      log('error', 'COOKIE_SECRET is not set (or left at its default placeholder) while NODE_ENV=production. Refusing to start with an insecure secret.');
      process.exit(1);
    } else if (!IS_TEST) {
      log('warn', 'COOKIE_SECRET is not set - using an insecure default. Set COOKIE_SECRET in .env before deploying to production.');
    }
  }
}

validateEnv();

// Proxy configuration
const PROXY_CHECK_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours
const PROXY_CHECK_TIMEOUT = 15000; // 15 seconds
const PROXY_CHECK_CONCURRENCY = 10;
const PROXY_FAILURE_THRESHOLD = 5;
const ALERT_COOLDOWN = 15 * 60 * 1000; // 15 minutes

// Czech proxy pool
let czechProxies = [];
let currentProxyIndex = 0;
let proxyCheckInProgress = false;
const proxyMiddlewareCache = new Map();
const proxyFailureCounts = new Map();
const lastAlertSentAt = new Map();

// Send an alert to Discord, throttled per `key` so a flapping condition
// doesn't spam the webhook.
function sendDiscordAlert(key, message) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl || IS_TEST) return;

  const now = Date.now();
  const last = lastAlertSentAt.get(key) || 0;
  if (now - last < ALERT_COOLDOWN) return;
  lastAlertSentAt.set(key, now);

  try {
    const url = new URL(webhookUrl);
    const payload = JSON.stringify({ content: message });
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => { res.on('data', () => {}); res.on('end', () => {}); });
    req.on('error', (err) => log('error', '[Alert] Failed to send Discord webhook:', err.message));
    req.write(payload);
    req.end();
  } catch (err) {
    log('error', '[Alert] Failed to send Discord webhook:', err.message);
  }
}

// Record the outcome of a request through a given proxy. Proxies that fail
// repeatedly are pulled out of rotation immediately instead of waiting for
// the next scheduled pool-wide health check.
function recordProxySuccess(proxy) {
  proxyFailureCounts.delete(proxy.username);
}

function recordProxyFailure(proxy) {
  const count = (proxyFailureCounts.get(proxy.username) || 0) + 1;
  proxyFailureCounts.set(proxy.username, count);

  if (count >= PROXY_FAILURE_THRESHOLD) {
    const idx = czechProxies.findIndex(p => p.username === proxy.username);
    if (idx !== -1) {
      czechProxies.splice(idx, 1);
      proxyMiddlewareCache.delete(proxy.username);
      proxyFailureCounts.delete(proxy.username);
      if (currentProxyIndex >= czechProxies.length) currentProxyIndex = 0;
      log('warn', `[Proxy] Blacklisting ${proxy.username} after ${count} consecutive failures (${czechProxies.length} proxies remain)`);

      if (czechProxies.length === 0) {
        sendDiscordAlert('pool-empty', `🚨 **Seznam-autobusu proxy**: last Czech proxy (${proxy.username}) was blacklisted after repeated failures - the pool is now empty.`);
      }
    }
  }
}

// Fetch proxy list from environment variable and Webshare
async function fetchProxyList() {
  let proxyList = [];

  // 1. Hardcoded proxies from PROXIES env
  const proxiesEnv = process.env.PROXIES || '';
  const envProxies = proxiesEnv.split(',').map(p => p.trim()).filter(p => p);
  
  if (envProxies.length > 0) {
    const parsedEnvProxies = envProxies.map(line => {
      const [host, port, username, password] = line.split(':');
      return { host, port, username, password };
    });
    proxyList = proxyList.concat(parsedEnvProxies);
  }

  // 2. Proxies from WEBSHARE_PROXY_URL env
  const webshareUrl = process.env.WEBSHARE_PROXY_URL;
  if (webshareUrl) {
    try {
      const webshareProxies = await new Promise((resolve, reject) => {
        https.get(webshareUrl, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode !== 200) {
               log('warn', `[Proxy] Failed to fetch Webshare proxies: Status ${res.statusCode}`);
               return resolve([]);
            }
            const proxies = data.trim().split('\n').map(line => {
              const parts = line.split(':');
              if (parts.length >= 4) {
                 return { host: parts[0], port: parts[1], username: parts[2], password: parts[3] };
              }
              return null;
            }).filter(p => p);
            resolve(proxies);
          });
        }).on('error', reject);
      });
      proxyList = proxyList.concat(webshareProxies);
    } catch (e) {
      log('warn', `[Proxy] Error fetching from WEBSHARE_PROXY_URL: ${e.message}`);
    }
  }

  if (proxyList.length === 0) {
    log('warn', '[Proxy] No proxies defined in PROXIES or WEBSHARE_PROXY_URL environment variables.');
  }

  return proxyList;
}

// Check if a proxy has a Czech IP
async function checkProxyCountry(proxy) {
  const proxyUrl = `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`;
  const { HttpProxyAgent } = require('http-proxy-agent');
  const agent = new HttpProxyAgent(proxyUrl);

  return new Promise((resolve) => {
    const req = http.get('http://ip-api.com/json/?fields=status,countryCode,city,query', { agent, timeout: PROXY_CHECK_TIMEOUT }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const info = JSON.parse(data);
          if (info.status === 'success') {
            resolve({
              proxy,
              country: info.countryCode,
              city: info.city,
              ip: info.query,
              isCzech: info.countryCode === 'CZ'
            });
          } else {
            resolve({ proxy, country: null, isCzech: false, error: info.message || 'API error' });
          }
        } catch (e) {
          resolve({ proxy, country: null, isCzech: false, error: 'Parse error: ' + data.substring(0, 100) });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ proxy, country: null, isCzech: false, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ proxy, country: null, isCzech: false, error: 'Timeout' });
    });
  });
}

// Check all proxies (in parallel batches) and find the Czech ones
async function checkAllProxies() {
  if (proxyCheckInProgress) {
    log('info', '[Proxy] Check already in progress, skipping...');
    return;
  }

  proxyCheckInProgress = true;
  log('info', `[Proxy] Starting proxy check`);

  try {
    const proxies = await fetchProxyList();
    log('info', `[Proxy] Fetched ${proxies.length} proxies from sources`);
    proxyCheckTotal = proxies.length;
    proxyCheckCurrent = 0;

    const newCzechProxies = [];

    for (let i = 0; i < proxies.length; i += PROXY_CHECK_CONCURRENCY) {
      const batch = proxies.slice(i, i + PROXY_CHECK_CONCURRENCY);
      const results = await Promise.all(batch.map(proxy => checkProxyCountry(proxy)));

      results.forEach((result, j) => {
        const proxy = batch[j];
        proxyCheckCurrent = i + j + 1;

        if (result.isCzech) {
          log('info', `[Proxy] ✓ ${proxy.username} is Czech (${result.city}, IP: ${result.ip})`);
          newCzechProxies.push({
            host: proxy.host,
            port: proxy.port,
            username: proxy.username,
            password: proxy.password,
            ip: result.ip,
            city: result.city
          });
        } else if (result.error) {
          log('info', `[Proxy] ✗ ${proxy.username} error: ${result.error}`);
        } else {
          log('info', `[Proxy] ✗ ${proxy.username} is ${result.country || 'Unknown'}`);
        }
      });
    }

    if (newCzechProxies.length > 0) {
      czechProxies = newCzechProxies;
      currentProxyIndex = 0;
      proxyMiddlewareCache.clear(); // Clear cache when proxies change
      proxyFailureCounts.clear();
      log('info', `[Proxy] ========================================`);
      log('info', `[Proxy] Found ${czechProxies.length} Czech proxies`);
      log('info', `[Proxy] ========================================`);
    } else {
      log('warn', `[Proxy] No Czech proxies found, keeping existing ${czechProxies.length} proxies`);
      if (czechProxies.length === 0) {
        sendDiscordAlert('pool-empty', `🚨 **Seznam-autobusu proxy**: no Czech proxies available. Checked ${proxies.length} proxies, none passed. The server cannot serve traffic.`);
      }
    }

  } catch (error) {
    log('error', '[Proxy] Error checking proxies:', error.message);
  } finally {
    proxyCheckInProgress = false;
  }
}

// Get current proxy agent (rotates through Czech proxies)
function getCurrentProxyAgent() {
  if (czechProxies.length === 0) {
    return null;
  }

  const proxy = czechProxies[currentProxyIndex];
  currentProxyIndex = (currentProxyIndex + 1) % czechProxies.length;

  const proxyUrl = `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`;
  return new HttpsProxyAgent(proxyUrl);
}

// Get current proxy info for logging
function getCurrentProxyInfo() {
  if (czechProxies.length === 0) {
    return 'No Czech proxies available';
  }
  const idx = currentProxyIndex === 0 ? czechProxies.length - 1 : currentProxyIndex - 1;
  const proxy = czechProxies[idx];
  return `${proxy.username} (${proxy.city}, ${proxy.ip})`;
}

// Initialize Express app
const app = express();

// Trust the reverse proxy in front of us (e.g. Caddy) so req.ip reflects the
// real client instead of the upstream hop - affects rate limiting accuracy.
app.set('trust proxy', 1);

// Metrics (simple in-memory counters, exposed via /metrics)
const metrics = {
  requestsTotal: 0,
  requestsByStatus: {},
  proxyErrorsTotal: 0,
  rateLimitedTotal: 0
};

// Middleware
app.use(compression());
app.use(helmet({
  // We're transparently proxying a third-party site's HTML/CSS/JS under our
  // own origin, so a strict default-src would break it. Still worth setting
  // real directives (instead of `false`) for the protections that don't
  // depend on knowing the upstream's asset hosts in advance.
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'", '*'],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", '*'],
      styleSrc: ["'self'", "'unsafe-inline'", '*'],
      imgSrc: ["'self'", 'data:', 'blob:', '*'],
      fontSrc: ["'self'", 'data:', '*'],
      connectSrc: ["'self'", '*'],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
      upgradeInsecureRequests: []
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false
}));
app.use(cookieParser(COOKIE_SECRET));

app.use((req, res, next) => {
  metrics.requestsTotal++;
  res.on('finish', () => {
    const code = res.statusCode;
    metrics.requestsByStatus[code] = (metrics.requestsByStatus[code] || 0) + 1;
  });
  next();
});

// Simple rate limiting
const requestCounts = new Map();
setInterval(() => requestCounts.clear(), 60000).unref(); // Reset every minute

const rateLimiter = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const count = requestCounts.get(ip) || 0;

  if (count > 100) {
    metrics.rateLimitedTotal++;
    return res.status(429).send('Too many requests. Please try again later.');
  }

  requestCounts.set(ip, count + 1);
  next();
};

app.use(rateLimiter);

// Language detection helper
function detectLanguage(req) {
  const acceptLanguage = req.headers['accept-language'] || '';
  const languages = acceptLanguage.toLowerCase();

  // Check for Czech or Slovak
  if (languages.includes('cs') || languages.includes('sk')) {
    return 'cs';
  }

  return 'en';
}

// Warning messages
const warningMessages = {
  cs: {
    title: "DŮLEŽITÉ VAROVÁNÍ",
    main_warning: "POZOR! Toto je proxy server vytvořený umělou inteligencí (vibecoding) na žádost mxnticek.eu/cyn.cz.",
    credentials_warning: "ZA BOHA PLATNÉHO I MRTVÉHO TU NEZADÁVEJTE PŘIHLAŠOVACÍ ÚDAJE!",
    disclaimer: "Pokud vám někdo ukradne přihlašovací údaje, protože jste je zadali přes tuto proxy, NECHCI O TOM SLYŠET.",
    button: "Rozumím rizikům, pokračovat →",
    info_created: "Vytvořeno",
    info_requested: "Na žádost",
    info_purpose: "Účel",
    info_purpose_value: "Přístup k seznam-autobusu.cz ze zahraničí",
    info_security: "Bezpečnost",
    info_security_value: "Proxy pouze zobrazuje veřejný obsah",
    support_title: "Podpořte tento projekt",
    support_text: "Tento projekt stojí $5 měsíčně kvůli českým proxy serverům. Pokud jej chcete podpořit, můžete zde:",
    footer: "Seznam-autobusu.cz Proxy | Proxy přes českou IP adresu"
  },
  en: {
    title: "IMPORTANT WARNING",
    main_warning: "WARNING! This is a proxy server created by AI (vibecoding) at the request of mxnticek.eu/cyn.cz.",
    credentials_warning: "DO NOT, UNDER ANY CIRCUMSTANCES, LIVING OR DEAD, ENTER YOUR LOGIN CREDENTIALS HERE!",
    disclaimer: "If someone steals your credentials because you entered them through this proxy, I DON'T WANT TO HEAR ABOUT IT.",
    button: "I understand the risks, continue →",
    info_created: "Created by",
    info_requested: "Requested by",
    info_purpose: "Purpose",
    info_purpose_value: "Access seznam-autobusu.cz from outside Czech Republic",
    info_security: "Security",
    info_security_value: "Proxy only displays public content",
    support_title: "Support this project",
    support_text: "This proxy costs $5/month for the Czech proxy servers. If you'd like to support it, you can here:",
    footer: "Seznam-autobusu.cz Proxy | Proxy through Czech IP address"
  }
};

// Load warning page template
let warningTemplate = null;
let loadingTemplate = null;
try {
  warningTemplate = fs.readFileSync(path.join(__dirname, 'views', 'warning.html'), 'utf8');
  loadingTemplate = fs.readFileSync(path.join(__dirname, 'views', 'loading.html'), 'utf8');
} catch (error) {
  console.error('Failed to load html templates:', error.message);
  process.exit(1);
}

// Loading messages
const loadingMessages = {
  cs: {
    title: "Inicializace Proxy",
    subtitle: "Prosím čekejte, ověřuji dostupnost českých proxy serverů..."
  },
  en: {
    title: "Initializing Proxy",
    subtitle: "Please wait, verifying availability of Czech proxy servers..."
  }
};

// Generate loading page HTML from template
function generateLoadingPage(lang) {
  const msg = loadingMessages[lang] || loadingMessages.en;
  let html = loadingTemplate
    .replace(/{{LANG}}/g, lang)
    .replace(/{{TITLE}}/g, msg.title)
    .replace(/{{SUBTITLE}}/g, msg.subtitle);
  return html;
}

// Generate warning page HTML from template
function generateWarningPage(lang, originalUrl) {
  const msg = warningMessages[lang] || warningMessages.en;

  // Replace all placeholders in template
  let html = warningTemplate
    .replace(/{{LANG}}/g, lang)
    .replace(/{{TITLE}}/g, msg.title)
    .replace(/{{MAIN_WARNING}}/g, msg.main_warning)
    .replace(/{{CREDENTIALS_WARNING}}/g, msg.credentials_warning)
    .replace(/{{DISCLAIMER}}/g, msg.disclaimer)
    .replace(/{{BUTTON}}/g, msg.button)
    .replace(/{{INFO_CREATED}}/g, msg.info_created)
    .replace(/{{INFO_REQUESTED}}/g, msg.info_requested)
    .replace(/{{INFO_PURPOSE}}/g, msg.info_purpose)
    .replace(/{{INFO_PURPOSE_VALUE}}/g, msg.info_purpose_value)
    .replace(/{{INFO_SECURITY}}/g, msg.info_security)
    .replace(/{{INFO_SECURITY_VALUE}}/g, msg.info_security_value)
    .replace(/{{SUPPORT_TITLE}}/g, msg.support_title)
    .replace(/{{SUPPORT_TEXT}}/g, msg.support_text)
    .replace(/{{FOOTER}}/g, msg.footer)
    .replace(/{{ORIGINAL_URL}}/g, encodeURIComponent(originalUrl));

  return html;
}

// Accept warning endpoint
app.get('/accept-warning', (req, res) => {
  const redirect = req.query.redirect || '/';
  res.cookie(WARNING_COOKIE, 'true', {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    httpOnly: true,
    signed: true
  });
  res.redirect(redirect);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: czechProxies.length > 0 ? 'ok' : 'no_proxies',
    timestamp: new Date().toISOString(),
    target: TARGET_URL,
    czechProxies: czechProxies.length,
    proxyCheckInProgress: proxyCheckInProgress
  });
});

// Proxy check progress endpoint
app.get('/proxy-check-progress', (req, res) => {
  res.status(200).json({
    total: proxyCheckTotal,
    current: proxyCheckCurrent,
    inProgress: proxyCheckInProgress,
    ready: czechProxies.length > 0
  });
});

// Prometheus-style metrics endpoint
app.get('/metrics', (req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4');
  const statusLines = Object.entries(metrics.requestsByStatus)
    .map(([code, count]) => `seznam_proxy_requests_by_status_total{status="${code}"} ${count}`)
    .join('\n');

  res.send(
`# HELP seznam_proxy_requests_total Total HTTP requests received
# TYPE seznam_proxy_requests_total counter
seznam_proxy_requests_total ${metrics.requestsTotal}

# HELP seznam_proxy_requests_by_status_total Total HTTP requests by response status code
# TYPE seznam_proxy_requests_by_status_total counter
${statusLines}

# HELP seznam_proxy_rate_limited_total Total requests rejected by the rate limiter
# TYPE seznam_proxy_rate_limited_total counter
seznam_proxy_rate_limited_total ${metrics.rateLimitedTotal}

# HELP seznam_proxy_errors_total Total upstream proxy errors
# TYPE seznam_proxy_errors_total counter
seznam_proxy_errors_total ${metrics.proxyErrorsTotal}

# HELP seznam_proxy_czech_proxies Current number of healthy Czech proxies in the pool
# TYPE seznam_proxy_czech_proxies gauge
seznam_proxy_czech_proxies ${czechProxies.length}

# HELP seznam_proxy_check_in_progress Whether a proxy pool health check is currently running
# TYPE seznam_proxy_check_in_progress gauge
seznam_proxy_check_in_progress ${proxyCheckInProgress ? 1 : 0}
`);
});

// Proxy status endpoint
app.get('/proxy-status', (req, res) => {
  res.status(200).json({
    timestamp: new Date().toISOString(),
    czechProxies: czechProxies.map(p => ({
      username: p.username,
      ip: p.ip,
      city: p.city
    })),
    totalCount: czechProxies.length,
    checkInProgress: proxyCheckInProgress,
    nextCheck: new Date(Date.now() + PROXY_CHECK_INTERVAL).toISOString()
  });
});

// URL rewriting helper - rewrites a value that IS a URL (href/src/action/...)
function rewriteUrl(url, proxyHost) {
  if (!url) return url;

  // Handle absolute URLs
  if (url.startsWith('https://seznam-autobusu.cz') || url.startsWith('http://seznam-autobusu.cz')) {
    return url.replace(/https?:\/\/seznam-autobusu\.cz/, `https://${proxyHost}`);
  }

  // Handle protocol-relative URLs
  if (url.startsWith('//seznam-autobusu.cz')) {
    return url.replace('//seznam-autobusu.cz', `//${proxyHost}`);
  }

  return url;
}

// Rewrites any occurrences of the target domain inside a larger string, e.g.
// meta-refresh content ("5;url=https://seznam-autobusu.cz/foo") or a Location
// header, where the value isn't itself purely a URL so rewriteUrl's
// startsWith checks would never match.
function rewriteUrlsInText(text, proxyHost) {
  if (!text) return text;
  return text
    .replace(/https?:\/\/seznam-autobusu\.cz/g, `https://${proxyHost}`)
    .replace(/\/\/seznam-autobusu\.cz/g, `//${proxyHost}`);
}

// Removes the Domain= attribute from a Set-Cookie header value, so the
// browser scopes the cookie to whichever host actually set it (us) instead
// of the upstream's real domain, which it would otherwise reject/ignore.
function stripCookieDomain(cookie) {
  return cookie.replace(/;\s*Domain=[^;]+/i, '');
}

// HTML rewriting function
function rewriteHtml(html, proxyHost, req) {
  const $ = cheerio.load(html);

  // Rewrite links
  $('a[href]').each((i, elem) => {
    const href = $(elem).attr('href');
    $(elem).attr('href', rewriteUrl(href, proxyHost));
  });

  // Rewrite forms
  $('form[action]').each((i, elem) => {
    const action = $(elem).attr('action');
    $(elem).attr('action', rewriteUrl(action, proxyHost));
  });

  // Rewrite images
  $('img[src]').each((i, elem) => {
    const src = $(elem).attr('src');
    $(elem).attr('src', rewriteUrl(src, proxyHost));
  });

  // Rewrite scripts
  $('script[src]').each((i, elem) => {
    const src = $(elem).attr('src');
    $(elem).attr('src', rewriteUrl(src, proxyHost));
  });

  // Rewrite stylesheets
  $('link[href]').each((i, elem) => {
    const href = $(elem).attr('href');
    $(elem).attr('href', rewriteUrl(href, proxyHost));
  });

  // Rewrite srcset (responsive images: "url widthdescriptor, url2 widthdescriptor")
  $('[srcset]').each((i, elem) => {
    const srcset = $(elem).attr('srcset');
    if (!srcset) return;
    const rewritten = srcset.split(',').map(part => {
      const trimmed = part.trim();
      if (!trimmed) return trimmed;
      const spaceIdx = trimmed.indexOf(' ');
      if (spaceIdx === -1) return rewriteUrl(trimmed, proxyHost);
      return rewriteUrl(trimmed.slice(0, spaceIdx), proxyHost) + trimmed.slice(spaceIdx);
    }).join(', ');
    $(elem).attr('srcset', rewritten);
  });

  // Rewrite inline style="...url(...)" attributes
  $('[style]').each((i, elem) => {
    const style = $(elem).attr('style');
    if (style && style.includes('url(')) {
      $(elem).attr('style', rewriteCss(style, proxyHost));
    }
  });

  // Rewrite meta tags - content isn't always a bare URL (e.g. meta-refresh's
  // "5;url=https://..."), so scan/replace anywhere in the string.
  $('meta[content]').each((i, elem) => {
    const content = $(elem).attr('content');
    if (content && content.includes('seznam-autobusu.cz')) {
      $(elem).attr('content', rewriteUrlsInText(content, proxyHost));
    }
  });

  // Inject Warning Overlay Button and Modal
  const lang = req ? detectLanguage(req) : 'en';
  const msg = warningMessages[lang] || warningMessages.en;
  
  $('body').append(`
    <style>
      #proxy-warning-overlay-btn {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 999999;
        background: rgba(30, 41, 59, 0.9);
        backdrop-filter: blur(8px);
        color: white;
        border: 1px solid rgba(255, 255, 255, 0.1);
        padding: 10px 16px;
        border-radius: 99px;
        font-family: 'Inter', sans-serif;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 8px;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
        transition: all 0.2s ease;
      }
      #proxy-warning-overlay-btn:hover {
        transform: translateY(-2px);
        background: rgba(40, 51, 69, 0.95);
        border: 1px solid rgba(255, 255, 255, 0.2);
        box-shadow: 0 15px 30px -5px rgba(0, 0, 0, 0.6);
      }
      #proxy-warning-modal-overlay {
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(2, 6, 23, 0.8);
        backdrop-filter: blur(12px);
        z-index: 1000000;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 20px;
        font-family: 'Inter', system-ui, sans-serif;
      }
      #proxy-warning-modal {
        background: rgba(15, 23, 42, 0.9);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 24px;
        padding: 30px;
        max-width: 450px;
        width: 100%;
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.8);
        color: #f8fafc;
        position: relative;
      }
      #proxy-warning-modal h2 {
        font-size: 22px;
        font-weight: 800;
        margin-top: 0;
        margin-bottom: 12px;
        color: #fff;
      }
      #proxy-warning-modal p {
        font-size: 14px;
        line-height: 1.5;
        color: #94a3b8;
        margin-bottom: 20px;
      }
      .proxy-danger-box {
        background: rgba(153, 27, 27, 0.15);
        border: 1px solid rgba(239, 68, 68, 0.3);
        border-radius: 12px;
        padding: 16px;
        margin-bottom: 20px;
      }
      .proxy-danger-box p {
        color: #fecaca !important;
        font-weight: 600;
        margin: 0 !important;
      }
      #proxy-modal-close-btn {
        background: #fff;
        color: #0f172a;
        border: none;
        padding: 12px 20px;
        border-radius: 8px;
        font-weight: 700;
        width: 100%;
        cursor: pointer;
        font-size: 15px;
        margin-top: 10px;
      }
      #proxy-modal-close-btn:hover {
        background: #f1f5f9;
      }
      .proxy-support-box {
        border-top: 1px solid rgba(255, 255, 255, 0.1);
        padding-top: 20px;
        margin-top: 20px;
      }
      .proxy-support-box h3 {
        font-size: 16px;
        margin-bottom: 8px;
        color: #fff;
      }
      .proxy-support-links {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      .proxy-support-link {
        flex: 1;
        min-width: 140px;
        background: rgba(59, 130, 246, 0.2);
        border: 1px solid rgba(59, 130, 246, 0.4);
        color: #93c5fd;
        text-align: center;
        padding: 10px;
        border-radius: 8px;
        text-decoration: none;
        font-size: 13px;
        font-weight: 600;
        transition: all 0.2s;
      }
      .proxy-support-link:hover {
        background: rgba(59, 130, 246, 0.3);
        transform: translateY(-1px);
      }
    </style>

    <button id="proxy-warning-overlay-btn" onclick="document.getElementById('proxy-warning-modal-overlay').style.display='flex'">
      <span>⚠️</span> Show Warning
    </button>

    <div id="proxy-warning-modal-overlay">
      <div id="proxy-warning-modal">
        <h2>${msg.title.replace(/'/g, "&#39;")}</h2>
        <p>${msg.main_warning.replace(/'/g, "&#39;")}</p>
        
        <div class="proxy-danger-box">
          <p>🛑 ${msg.credentials_warning.replace(/'/g, "&#39;")}</p>
        </div>
        
        <p style="font-style:italic; font-size:13px; text-align:center; margin-bottom: 20px;">"${msg.disclaimer.replace(/'/g, "&#39;")}"</p>
        
        <div class="proxy-support-box">
          <h3>${msg.support_title.replace(/'/g, "&#39;")}</h3>
          <p style="font-size: 13px; margin-bottom: 12px;">${msg.support_text.replace(/'/g, "&#39;")}</p>
          <div class="proxy-support-links">
            <a href="https://ko-fi.com/vlastimilnovotny" target="_blank" class="proxy-support-link">☕ Ko-fi</a>
            <a href="https://donate.odjezdy.online" target="_blank" class="proxy-support-link">🔗 odjezdy.online</a>
          </div>
        </div>

        <button id="proxy-modal-close-btn" onclick="document.getElementById('proxy-warning-modal-overlay').style.display='none'">
          Close / Zavřít
        </button>
      </div>
    </div>
  `);

  return $.html();
}

// CSS rewriting function
function rewriteCss(css, proxyHost) {
  // Rewrite url() references in CSS
  return css.replace(/url\(['"]?([^'")\s]+)['"]?\)/g, (match, url) => {
    const rewritten = rewriteUrl(url, proxyHost);
    return `url('${rewritten}')`;
  });
}

// Create proxy middleware for a specific proxy config (cached)
function getOrCreateProxyMiddleware(proxy) {
  if (proxyMiddlewareCache.has(proxy.username)) {
    return proxyMiddlewareCache.get(proxy.username);
  }

  const proxyUrl = `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`;
  const agent = new HttpsProxyAgent(proxyUrl);

  const middleware = createProxyMiddleware({
    target: TARGET_URL,
    changeOrigin: true,
    followRedirects: true,
    secure: false,
    agent: agent,
    selfHandleResponse: true,
    logLevel: 'silent',
    onProxyRes: (proxyRes, req, res) => {
      const proxyHost = req.get('host');
      const contentType = proxyRes.headers['content-type'] || '';
      const encoding = proxyRes.headers['content-encoding'];

      if (proxyRes.statusCode >= 500) {
        recordProxyFailure(proxy);
      } else {
        recordProxySuccess(proxy);
      }

      delete proxyRes.headers['content-security-policy'];
      delete proxyRes.headers['x-frame-options'];

      // Redirects from the upstream would otherwise leak the real domain
      if (proxyRes.headers['location']) {
        proxyRes.headers['location'] = rewriteUrlsInText(proxyRes.headers['location'], proxyHost);
      }

      // Cookies set with a Domain= attribute for seznam-autobusu.cz won't be
      // honored by the browser under our domain.
      if (proxyRes.headers['set-cookie']) {
        proxyRes.headers['set-cookie'] = proxyRes.headers['set-cookie'].map(stripCookieDomain);
      }

      Object.keys(proxyRes.headers).forEach(key => {
        res.setHeader(key, proxyRes.headers[key]);
      });

      if (contentType.includes('text/html')) {
        let body = [];
        let stream = proxyRes;
        if (encoding === 'gzip') stream = proxyRes.pipe(zlib.createGunzip());
        else if (encoding === 'deflate') stream = proxyRes.pipe(zlib.createInflate());
        else if (encoding === 'br') stream = proxyRes.pipe(zlib.createBrotliDecompress());

        stream.on('data', (chunk) => body.push(chunk));
        stream.on('end', () => {
          const bodyString = Buffer.concat(body).toString('utf8');
          const rewrittenHtml = rewriteHtml(bodyString, proxyHost, req);
          res.removeHeader('content-encoding');
          res.removeHeader('content-length');
          res.setHeader('content-length', Buffer.byteLength(rewrittenHtml));
          res.statusCode = proxyRes.statusCode;
          res.end(rewrittenHtml);
        });
      }
      else if (contentType.includes('text/css')) {
        let body = [];
        let stream = proxyRes;
        if (encoding === 'gzip') stream = proxyRes.pipe(zlib.createGunzip());
        else if (encoding === 'deflate') stream = proxyRes.pipe(zlib.createInflate());
        else if (encoding === 'br') stream = proxyRes.pipe(zlib.createBrotliDecompress());

        stream.on('data', (chunk) => body.push(chunk));
        stream.on('end', () => {
          const bodyString = Buffer.concat(body).toString('utf8');
          const rewrittenCss = rewriteCss(bodyString, proxyHost);
          res.removeHeader('content-encoding');
          res.removeHeader('content-length');
          res.setHeader('content-length', Buffer.byteLength(rewrittenCss));
          res.statusCode = proxyRes.statusCode;
          res.end(rewrittenCss);
        });
      }
      else {
        res.statusCode = proxyRes.statusCode;
        proxyRes.pipe(res);
      }
    },
    onError: (err, req, res) => {
      metrics.proxyErrorsTotal++;
      recordProxyFailure(proxy);

      if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE'].includes(err.code)) {
        return;
      }
      log('error', 'Proxy error:', err.message);
      if (!res.headersSent) {
        res.status(502).send('Proxy error: Unable to reach seznam-autobusu.cz. Please try again later.');
      }
    }
  });

  proxyMiddlewareCache.set(proxy.username, middleware);
  return middleware;
}

// Assigns each browser a stable per-session id, so a given visitor keeps
// hitting the same upstream Czech proxy instead of a different IP on every
// single request (which can look suspicious to the target site).
function getOrCreateSessionId(req, res) {
  let sessionId = req.cookies[SESSION_COOKIE];
  if (!sessionId || !/^[a-f0-9]{32}$/.test(sessionId)) {
    sessionId = crypto.randomBytes(16).toString('hex');
    res.cookie(SESSION_COOKIE, sessionId, {
      maxAge: 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax'
    });
  }
  return sessionId;
}

// Deterministically maps a session id to one of the currently healthy proxies.
function pickProxyForSession(sessionId) {
  if (czechProxies.length === 0) return null;
  const hash = crypto.createHash('md5').update(sessionId).digest();
  const index = hash.readUInt32BE(0) % czechProxies.length;
  return czechProxies[index];
}

// Dynamic proxy handler
function proxyMiddleware(req, res, next) {
  if (czechProxies.length === 0) {
    return res.status(503).send('No Czech proxies available.');
  }

  const sessionId = getOrCreateSessionId(req, res);
  const proxy = pickProxyForSession(sessionId);

  log('info', `${req.method} ${req.path} -> ${proxy.username} (${proxy.city}, ${proxy.ip}) [session ${sessionId.slice(0, 8)}]`);

  const middleware = getOrCreateProxyMiddleware(proxy);
  middleware(req, res, next);
}

const cacheOptions = {
  statusCodes: {
    include: [200],
  },
};
const cacheMiddleware = apicache.middleware('5 minutes', (req, res) => res.statusCode === 200 && req.method === 'GET');

// Main proxy handler with warning page check
app.use((req, res, next) => {
  // Skip warning for health check, accept-warning, proxy-status, metrics, and progress polling
  if (req.path === '/health' || req.path === '/accept-warning' || req.path === '/proxy-status' ||
      req.path === '/metrics' || req.path === '/proxy-check-progress') {
    return next();
  }

  // Check if we have Czech proxies available
  if (czechProxies.length === 0) {
    if (proxyCheckInProgress) {
      const lang = detectLanguage(req);
      return res.status(503).send(generateLoadingPage(lang));
    }
    return res.status(503).send('No Czech proxies available. Server is still initializing or proxy check failed. Please try again later.');
  }

  // Check if user has accepted warning
  const hasAcceptedWarning = req.signedCookies[WARNING_COOKIE] === 'true';

  if (!hasAcceptedWarning) {
    const lang = detectLanguage(req);
    const originalUrl = req.originalUrl;
    const warningHtml = generateWarningPage(lang, originalUrl);
    return res.send(warningHtml);
  }

  // User has accepted warning, proceed to proxy
  cacheMiddleware(req, res, () => {
    proxyMiddleware(req, res, next);
  });
});

// Only actually bind a port / hit the network when run directly (`node
// server.js`), not when required as a module by the test suite.
if (require.main === module) {
  const server = app.listen(PORT, async () => {
    console.log('==========================================');
    console.log('Seznam-autobusu.cz Proxy Server');
    console.log('==========================================');
    console.log(`Port: ${PORT}`);
    console.log(`Target: ${TARGET_URL}`);
    console.log(`Health Check: http://localhost:${PORT}/health`);
    console.log(`Proxy Status: http://localhost:${PORT}/proxy-status`);
    console.log(`Metrics: http://localhost:${PORT}/metrics`);
    console.log('==========================================');
    console.log('Server started. Checking for Czech proxies...');
    console.log('==========================================');

    // Initial proxy check
    await checkAllProxies();

    // Schedule proxy checks every 2 hours
    setInterval(checkAllProxies, PROXY_CHECK_INTERVAL);
    log('info', `[Proxy] Next check scheduled in 2 hours`);
  });

  function shutdown(signal) {
    log('info', `[Server] Received ${signal}, shutting down gracefully...`);
    server.close(() => {
      log('info', '[Server] HTTP server closed.');
      process.exit(0);
    });
    // Don't hang forever if a connection never closes
    setTimeout(() => {
      log('error', '[Server] Forced shutdown after timeout.');
      process.exit(1);
    }, 10000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;
module.exports._internal = {
  rewriteUrl,
  rewriteUrlsInText,
  rewriteHtml,
  rewriteCss,
  stripCookieDomain,
  detectLanguage,
  generateWarningPage,
  generateLoadingPage,
  pickProxyForSession
};
