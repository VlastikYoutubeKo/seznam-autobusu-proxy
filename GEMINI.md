# Seznam-autobusu.cz Proxy - Project Context

## Project Overview
This project is a Node.js-based reverse proxy designed to bypass geographical restrictions for accessing `seznam-autobusu.cz` from outside the Czech Republic. It acts as a transparent proxy, automatically fetching a list of proxies from Webshare, filtering for Czech IPs, and rotating them for incoming requests. It also features a session-based, multi-language warning page that users must accept before accessing the proxied content.

## Main Technologies
- **Runtime**: Node.js
- **Web Framework**: Express
- **Proxying**: `http-proxy-middleware`, `https-proxy-agent`
- **Content Rewriting**: `cheerio` (for HTML parsing and URL rewriting)
- **Containerization**: Docker, Docker Compose

## Architecture & Core Features
- **Dynamic Proxy Rotation**: Fetches proxy lists from Webshare, validates them to ensure they have a Czech IP address, and rotates them for subsequent requests.
- **Content Rewriting**: Intercepts HTML and CSS responses to rewrite absolute URLs, protocol-relative URLs, form actions, and asset links so they route back through the proxy.
- **Warning Page**: Displays a warning page (in Czech/Slovak or English, based on `Accept-Language` headers) on the first visit. Sets a signed cookie (`seznam_proxy_warned`) once accepted.
- **Rate Limiting**: Includes basic IP-based rate limiting (100 requests per minute).
- **Health & Status Endpoints**: Provides `/health` and `/proxy-status` endpoints for monitoring proxy pool status.

## Key Files
- `server.js`: The main application entry point. Contains the Express server setup, proxy fetching/validation logic, content rewriting mechanisms, and middleware configuration.
- `package.json`: Defines project metadata, dependencies, and npm scripts.
- `Dockerfile` & `docker-compose.yml`: Configuration for building and running the application within Docker containers.
- `views/warning.html`: The HTML template used for the initial warning page, populated dynamically by `server.js`.
- `.env.example`: Template for environment variables (e.g., `PORT`, `COOKIE_SECRET`, `UPSTREAM_PROXY`).

## Building and Running

### Direct Node.js
1. Install dependencies:
   ```bash
   npm install
   ```
2. Configure environment variables (copy `.env.example` to `.env`).
3. Run the server:
   - **Production**: `npm start`
   - **Development** (with auto-reload): `npm run dev`

### Docker (Recommended)
Use the provided `docker-compose` commands:
- Build and start in background: `docker-compose up -d --build`
- View logs: `docker-compose logs -f`
- Stop containers: `docker-compose down`

## Development Conventions
- **Environment Configuration**: Sensitive data and environment-specific settings (like `COOKIE_SECRET` and ports) are managed via `.env` files.
- **Error Handling**: The proxy handles connection errors (like timeouts and resets) gracefully, responding with 502/503 status codes when proxies are unavailable.
- **Security**: Utilizes `helmet` for basic security headers and signed cookies for the warning page acknowledgment to prevent tampering.
