# Seznam-autobusu.cz Proxy

Reverse proxy for [seznam-autobusu.cz](https://seznam-autobusu.cz) to bypass geographical restrictions and allow access from outside the Czech Republic.

## Author

- **Project by**: mxnticek ([mxnticek.eu](https://mxnticek.eu) / [cyn.cz](https://cyn.cz))
- **Created by**: vibecoding (Claude AI)

## Public Instance

The main instance runs at **[seznam.odjezdy.online](https://seznam.odjezdy.online)**,
using a pool of Czech IPs sourced primarily from [Webshare](https://www.webshare.io/).

If you'd like to support the project - proxies are the main running cost - signing up
for Webshare through this referral link helps fund the proxy pool:
[webshare.io/?referral_code=xse6mbni7qbv](https://www.webshare.io/?referral_code=xse6mbni7qbv)

## Features

- Transparent reverse proxy for seznam-autobusu.cz
- Smart URL rewriting for HTML, CSS, and JavaScript
- Multi-language warning page (Czech/Slovak vs English)
- Browser language detection from Accept-Language header
- Session-based warning (shown once per session)
- Mobile-responsive design
- Support for upstream SOCKS5/HTTP proxy
- Docker containerization ready
- Health check, proxy-status, and Prometheus-style `/metrics` endpoints
- Rate limiting and security headers (real CSP, not disabled)
- Sticky per-session proxy assignment (a given visitor keeps the same upstream IP)
- Automatic proxy health scoring - repeatedly failing proxies are pulled from rotation immediately
- Parallelized proxy pool health checks
- Optional Discord webhook alert when the Czech proxy pool is empty
- Graceful shutdown on SIGTERM/SIGINT (Docker-friendly)
- All paths and query parameters preserved
- Forms work correctly through proxy

## Warning Page

Before accessing the proxied site, users will see a warning page in their language:

- **Czech/Slovak users** (Accept-Language: cs, sk): See Czech warning
- **Other users**: See English warning

The warning clearly states:
- This is an AI-generated proxy
- Users should NOT enter login credentials
- Proxy is only for viewing public content

## Deployment Scenarios

Every request is proxied through a Czech IP from the `PROXIES`/`WEBSHARE_PROXY_URL`
pool - there's no direct-connection path, so **this is required regardless of
where you host the server**, even if the server itself already has a Czech IP:

1. Set `PROXIES` and/or `WEBSHARE_PROXY_URL` in `.env` (see [Configuration](#environment-variables))
2. On startup (and every 2 hours after), the server fetches those candidates,
   checks each one's IP via ip-api.com, and keeps only the ones that come
   back as Czech (`CZ`)
3. The server won't serve real traffic until at least one Czech proxy passes -
   `/health` returns `"status": "no_proxies"` until then

## Installation

### Prerequisites

- Node.js 18+ and npm 9+
- Docker and Docker Compose (optional)
- At least one working proxy with a Czech IP (via `PROXIES` and/or
  `WEBSHARE_PROXY_URL` - see [Deployment Scenarios](#deployment-scenarios))

### Method 1: Docker (Recommended)

1. **Clone the repository**
   ```bash
   cd /root
   git clone <repository-url> claude-proxy-sa
   cd claude-proxy-sa
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   nano .env
   ```

   Edit `.env` file:
   ```env
   PORT=3000
   NODE_ENV=production
   COOKIE_SECRET=your-random-secret-key-here

   # At least one of these is required (see Deployment Scenarios):
   PROXIES=proxy1.example.com:1080:user1:pass1,proxy2.example.com:1080:user2:pass2
   # WEBSHARE_PROXY_URL=https://proxy.webshare.io/api/v2/proxy/list/download/<token>/-/any/username/backbone/-/
   ```

3. **Build and start**
   ```bash
   docker-compose up -d
   ```

4. **Check logs**
   ```bash
   docker-compose logs -f
   ```

5. **Check health**
   ```bash
   curl http://localhost:3000/health
   ```

### Method 2: Direct Node.js

1. **Clone and install**
   ```bash
   cd /root
   git clone <repository-url> claude-proxy-sa
   cd claude-proxy-sa
   npm install
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   nano .env
   ```

3. **Start the server**
   ```bash
   # Production
   npm start

   # Development (with auto-reload)
   npm run dev
   ```

## Caddy Integration

To expose the proxy with SSL using Caddy:

1. **Create Caddyfile**
   ```bash
   nano /etc/caddy/Caddyfile
   ```

2. **Add configuration**
   ```
   your-domain.example {
       reverse_proxy localhost:3000

       log {
           output file /var/log/caddy/seznam-autobusu-proxy.log
           format json
       }

       encode gzip
   }
   ```

3. **Reload Caddy**
   ```bash
   systemctl reload caddy
   ```

## Testing

### Test Health Check
```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "ok",
  "timestamp": "2026-01-09T...",
  "target": "https://seznam-autobusu.cz",
  "czechProxies": 4,
  "proxyCheckInProgress": false
}
```

### Test Metrics
```bash
curl http://localhost:3000/metrics
```

Prometheus-style text output with request counts, proxy errors, rate-limit
rejections, and the current Czech proxy pool size.

### Test Warning Page (Czech)
```bash
curl -H "Accept-Language: cs-CZ" http://localhost:3000
```

Should return HTML with Czech warning.

### Test Warning Page (English)
```bash
curl -H "Accept-Language: en-US" http://localhost:3000
```

Should return HTML with English warning.

### Test Specific Path
```bash
curl http://localhost:3000/vuz/663928
```

Should show warning page (first visit) or proxied content (after accepting warning).

### Test Mobile Responsiveness

Use Chrome DevTools:
1. Open http://localhost:3000
2. Press F12 to open DevTools
3. Click device toolbar icon (or Ctrl+Shift+M)
4. Test different device sizes

## URL Mapping Examples

| Proxy URL | Original URL | Status |
|-----------|--------------|--------|
| `your-domain.example` | `seznam-autobusu.cz` | ✅ Works |
| `your-domain.example/vuz/663928` | `seznam-autobusu.cz/vuz/663928` | ✅ Works |
| `your-domain.example/hledat?q=test` | `seznam-autobusu.cz/hledat?q=test` | ✅ Works |
| `your-domain.example/static/css/style.css` | `seznam-autobusu.cz/static/css/style.css` | ✅ Works |

All paths, query parameters, and assets are automatically proxied.

## Configuration

### Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `PORT` | Server port | No | 3000 |
| `NODE_ENV` | Environment | No | production |
| `COOKIE_SECRET` | Cookie signing secret. If left at the default with `NODE_ENV=production`, the server refuses to start. | No (yes in production) | auto-generated |
| `PROXIES` | Comma-separated `host:port:user:pass` list of candidate proxies (any provider). Checked for a Czech IP and added to the rotation pool. | No* | none |
| `WEBSHARE_PROXY_URL` | Webshare's pre-authenticated proxy list "download" URL - merged with `PROXIES` on every health check. | No* | none |
| `DISCORD_WEBHOOK_URL` | Discord webhook for pool-empty alerts (throttled to 1/15min) | No | none |
| `UPSTREAM_PROXY` | ⚠️ Not currently read anywhere in `server.js` - leftover from an earlier single-upstream-proxy design, superseded by the `PROXIES`/`WEBSHARE_PROXY_URL` pool above. Setting it does nothing right now. | No | none |

\* At least one of `PROXIES` or `WEBSHARE_PROXY_URL` is required for the proxy to actually serve traffic - the pool of Czech IPs sourced from these is what every request rotates/sticks through (see [Public Instance](#public-instance) above for how the reference deployment configures this).

## Docker Commands

```bash
# Build
docker-compose build

# Start
docker-compose up -d

# Stop
docker-compose down

# View logs
docker-compose logs -f

# Restart
docker-compose restart

# Rebuild and restart
docker-compose up -d --build
```

## Troubleshooting

### Port Already in Use
```bash
# Check what's using port 3000
lsof -i :3000

# Change port in .env
PORT=3001
```

### Proxy Connection Failed
```bash
# Check if upstream proxy is reachable
curl -x socks5://user:pass@proxy:1080 https://seznam-autobusu.cz

# Check Docker logs
docker-compose logs
```

### Warning Page Not Showing
```bash
# Clear cookies in browser
# Or use incognito/private mode
```

### Assets Not Loading
```bash
# Check browser console for errors (F12)
# Verify all URLs are being rewritten correctly
```

## Security Notes

- The warning page clearly states NOT to enter login credentials
- Proxy only displays public content
- No login functionality should be used through the proxy
- Rate limiting prevents abuse (100 requests per minute per IP, based on the
  real client IP via `trust proxy` when running behind Caddy)
- Security headers enabled via Helmet.js, including a real (if permissive)
  Content-Security-Policy - needed because we're transparently serving a
  third-party site's own scripts/styles under our origin
- Cookies are signed and HTTP-only
- Upstream `Set-Cookie` and redirect (`Location`) headers are rewritten so
  the real seznam-autobusu.cz domain never leaks to the browser

## Project Structure

```
claude-proxy-sa/
├── server.js              # Main proxy server
├── __tests__/             # Jest + Supertest test suite
├── .github/workflows/     # CI (runs npm test on push/PR)
├── package.json           # Dependencies
├── Dockerfile             # Container build
├── docker-compose.yml     # Container orchestration
├── .env.example           # Environment template
├── .gitignore            # Git ignore rules
└── README.md             # This file
```

## How It Works

1. **User visits proxy URL** (e.g., your-domain.example)
2. **Server detects language** from Accept-Language header
3. **Warning page shown** in appropriate language (Czech or English)
4. **User clicks continue** → session cookie set
5. **All subsequent requests** are proxied transparently
6. **URL rewriting** ensures all links, CSS, JS go through proxy
7. **Headers manipulated** to appear as legitimate Czech request

## Development

```bash
# Install dependencies
npm install

# Run in development mode with auto-reload
npm run dev

# The server will restart automatically on file changes
```

## Automated Tests

```bash
npm test
```

Runs the Jest + Supertest suite in `__tests__/` (URL/HTML/CSS rewriting, language
detection, cookie-domain stripping, `/health`, `/metrics`, `/accept-warning`, and
rate limiting). Tests don't hit the network or bind a real port - `checkAllProxies()`
and `app.listen()` only run when the file is executed directly, not when required
as a module. CI runs this suite on every push via `.github/workflows/ci.yml`.

## License

MIT License - See project for details.

## Disclaimer

This proxy is designed for accessing **public content only** from seznam-autobusu.cz when geographical restrictions prevent access.

**DO NOT** use this proxy for:
- Entering login credentials
- Accessing private/authenticated content
- Any activities that violate seznam-autobusu.cz terms of service

The author takes no responsibility for misuse of this software.

## Support

For issues or questions:
- Create an issue in the repository
- Contact: mxnticek.eu / cyn.cz

---

**Created by vibecoding (Claude AI) at the request of mxnticek**
