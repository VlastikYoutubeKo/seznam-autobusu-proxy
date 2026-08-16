# Seznam-autobusu.cz Proxy

Reverse proxy for [seznam-autobusu.cz](https://seznam-autobusu.cz) to bypass geographical restrictions and allow access from outside the Czech Republic.

## Author

- **Project by**: mxnticek ([mxnticek.eu](https://mxnticek.eu) / [cyn.cz](https://cyn.cz))
- **Created by**: vibecoding (Claude AI)

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

### Scenario 1: Home Server (Czech IP)

If your server is located in Czech Republic with a Czech IP address:

1. No upstream proxy needed
2. Direct connection to seznam-autobusu.cz
3. Leave `UPSTREAM_PROXY` empty in `.env`

### Scenario 2: VPS (Outside Czech Republic)

If your server is in Germany or elsewhere:

1. Requires upstream Czech SOCKS5/HTTP proxy
2. Configure `UPSTREAM_PROXY` in `.env`
3. Example: `UPSTREAM_PROXY=socks5://user:pass@czech-proxy.com:1080`

## Installation

### Prerequisites

- Node.js 18+ and npm 9+
- Docker and Docker Compose (optional)
- Upstream Czech proxy (only for VPS scenario)

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

   # Only if outside Czech Republic:
   # UPSTREAM_PROXY=socks5://user:pass@proxy.example.com:1080
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
   sez-aut.cyn.cz {
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
| `sez-aut.cyn.cz` | `seznam-autobusu.cz` | ✅ Works |
| `sez-aut.cyn.cz/vuz/663928` | `seznam-autobusu.cz/vuz/663928` | ✅ Works |
| `sez-aut.cyn.cz/hledat?q=test` | `seznam-autobusu.cz/hledat?q=test` | ✅ Works |
| `sez-aut.cyn.cz/static/css/style.css` | `seznam-autobusu.cz/static/css/style.css` | ✅ Works |

All paths, query parameters, and assets are automatically proxied.

## Configuration

### Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `PORT` | Server port | No | 3000 |
| `NODE_ENV` | Environment | No | production |
| `COOKIE_SECRET` | Cookie signing secret. If left at the default with `NODE_ENV=production`, the server refuses to start. | No (yes in production) | auto-generated |
| `UPSTREAM_PROXY` | Upstream proxy URL | No | none |
| `DISCORD_WEBHOOK_URL` | Discord webhook for pool-empty alerts (throttled to 1/15min) | No | none |

### Upstream Proxy Format

**HTTP Proxy:**
```
UPSTREAM_PROXY=http://username:password@proxy.example.com:8080
```

**SOCKS5 Proxy:**
```
UPSTREAM_PROXY=socks5://username:password@proxy.example.com:1080
```

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

1. **User visits proxy URL** (e.g., sez-aut.cyn.cz)
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
