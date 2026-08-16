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
const apicache = require('apicache');

require('dotenv').config()

// Configuration
const PORT = process.env.PORT || 3000;
const TARGET_URL = 'https://seznam-autobusu.cz';
const COOKIE_SECRET = process.env.COOKIE_SECRET || 'seznam-proxy-secret-key';
const WARNING_COOKIE = 'seznam_proxy_warned';

// Proxy configuration
const PROXY_CHECK_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours
const PROXY_CHECK_TIMEOUT = 15000; // 15 seconds

// Czech proxy pool
let czechProxies = [];
let currentProxyIndex = 0;
let proxyCheckInProgress = false;
const proxyMiddlewareCache = new Map();

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
               console.warn(`[Proxy] Failed to fetch Webshare proxies: Status ${res.statusCode}`);
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
      console.warn(`[Proxy] Error fetching from WEBSHARE_PROXY_URL: ${e.message}`);
    }
  }

  if (proxyList.length === 0) {
    console.warn('[Proxy] No proxies defined in PROXIES or WEBSHARE_PROXY_URL environment variables.');
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

// Check all proxies and find Czech ones
async function checkAllProxies() {
  if (proxyCheckInProgress) {
    console.log('[Proxy] Check already in progress, skipping...');
    return;
  }

  proxyCheckInProgress = true;
  console.log(`[Proxy] Starting proxy check at ${new Date().toISOString()}`);

  try {
    const proxies = await fetchProxyList();
    console.log(`[Proxy] Fetched ${proxies.length} proxies from sources`);
    proxyCheckTotal = proxies.length;
    proxyCheckCurrent = 0;

    const newCzechProxies = [];

    for (let i = 0; i < proxies.length; i++) {
      proxyCheckCurrent = i + 1;
      const proxy = proxies[i];
      console.log(`[Proxy] Checking ${proxy.username} (${i + 1}/${proxies.length})...`);

      const result = await checkProxyCountry(proxy);

      if (result.isCzech) {
        console.log(`[Proxy] ✓ ${proxy.username} is Czech (${result.city}, IP: ${result.ip})`);
        newCzechProxies.push({
          host: proxy.host,
          port: proxy.port,
          username: proxy.username,
          password: proxy.password,
          ip: result.ip,
          city: result.city
        });
      } else if (result.error) {
        console.log(`[Proxy] ✗ ${proxy.username} error: ${result.error}`);
      } else {
        console.log(`[Proxy] ✗ ${proxy.username} is ${result.country || 'Unknown'}`);
      }
    }

    if (newCzechProxies.length > 0) {
      czechProxies = newCzechProxies;
      currentProxyIndex = 0;
      proxyMiddlewareCache.clear(); // Clear cache when proxies change
      console.log(`[Proxy] ========================================`);
      console.log(`[Proxy] Found ${czechProxies.length} Czech proxies`);
      console.log(`[Proxy] ========================================`);
    } else {
      console.log(`[Proxy] No Czech proxies found, keeping existing ${czechProxies.length} proxies`);
    }

  } catch (error) {
    console.error('[Proxy] Error checking proxies:', error.message);
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

// Middleware
app.use(compression());
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cookieParser(COOKIE_SECRET));

// Simple rate limiting
const requestCounts = new Map();
setInterval(() => requestCounts.clear(), 60000); // Reset every minute

const rateLimiter = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const count = requestCounts.get(ip) || 0;

  if (count > 100) {
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

// URL rewriting helper
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

  // Rewrite meta tags
  $('meta[content]').each((i, elem) => {
    const content = $(elem).attr('content');
    if (content && content.includes('seznam-autobusu.cz')) {
      $(elem).attr('content', rewriteUrl(content, proxyHost));
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

      delete proxyRes.headers['content-security-policy'];
      delete proxyRes.headers['x-frame-options'];

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
      if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE'].includes(err.code)) {
        return;
      }
      console.error('Proxy error:', err.message);
      if (!res.headersSent) {
        res.status(502).send('Proxy error: Unable to reach seznam-autobusu.cz. Please try again later.');
      }
    }
  });

  proxyMiddlewareCache.set(proxy.username, middleware);
  return middleware;
}

// Dynamic proxy handler
function proxyMiddleware(req, res, next) {
  if (czechProxies.length === 0) {
    return res.status(503).send('No Czech proxies available.');
  }

  const proxy = czechProxies[currentProxyIndex];
  currentProxyIndex = (currentProxyIndex + 1) % czechProxies.length;

  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} -> ${proxy.username} (${proxy.city}, ${proxy.ip})`);

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
  // Skip warning for health check, accept-warning, and proxy-status
  if (req.path === '/health' || req.path === '/accept-warning' || req.path === '/proxy-status') {
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

// Start server
app.listen(PORT, async () => {
  console.log('==========================================');
  console.log('Seznam-autobusu.cz Proxy Server');
  console.log('==========================================');
  console.log(`Port: ${PORT}`);
  console.log(`Target: ${TARGET_URL}`);
  console.log(`Health Check: http://localhost:${PORT}/health`);
  console.log(`Proxy Status: http://localhost:${PORT}/proxy-status`);
  console.log('==========================================');
  console.log('Server started. Checking for Czech proxies...');
  console.log('==========================================');

  // Initial proxy check
  await checkAllProxies();

  // Schedule proxy checks every 2 hours
  setInterval(checkAllProxies, PROXY_CHECK_INTERVAL);
  console.log(`[Proxy] Next check scheduled in 2 hours`);
});
