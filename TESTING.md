# Testing Guide for Seznam-autobusu.cz Proxy

This guide provides comprehensive testing instructions to verify all functionality works correctly.

## Prerequisites

- Server must be running (see README.md for setup)
- `curl` installed for command-line testing
- Browser for UI testing
- Access to browser DevTools (F12)

## 1. Health Check Test

Verify the server is running and healthy.

```bash
curl -i http://localhost:3000/health
```

**Expected Result:**
```
HTTP/1.1 200 OK
Content-Type: application/json

{
  "status": "ok",
  "timestamp": "2026-01-09T...",
  "target": "https://seznam-autobusu.cz",
  "czechProxies": 4,
  "proxyCheckInProgress": false
}
```

## 2. Language Detection Tests

### 2.1 Czech Warning Page

Test that Czech users see Czech warning.

```bash
curl -H "Accept-Language: cs-CZ,cs;q=0.9" http://localhost:3000/ | grep "DŮLEŽITÉ VAROVÁNÍ"
```

**Expected Result:** Should find "DŮLEŽITÉ VAROVÁNÍ" in output.

### 2.2 Slovak Warning Page

Test that Slovak users see Czech warning.

```bash
curl -H "Accept-Language: sk-SK,sk;q=0.9" http://localhost:3000/ | grep "DŮLEŽITÉ VAROVÁNÍ"
```

**Expected Result:** Should find "DŮLEŽITÉ VAROVÁNÍ" in output.

### 2.3 English Warning Page

Test that non-Czech/Slovak users see English warning.

```bash
curl -H "Accept-Language: en-US,en;q=0.9" http://localhost:3000/ | grep "IMPORTANT WARNING"
```

**Expected Result:** Should find "IMPORTANT WARNING" in output.

### 2.4 Other Languages Default to English

```bash
curl -H "Accept-Language: de-DE,de;q=0.9" http://localhost:3000/ | grep "IMPORTANT WARNING"
curl -H "Accept-Language: fr-FR,fr;q=0.9" http://localhost:3000/ | grep "IMPORTANT WARNING"
```

**Expected Result:** Both should find "IMPORTANT WARNING".

## 3. Browser Tests

### 3.1 First Visit - Warning Page

1. Open browser in incognito/private mode
2. Navigate to `http://localhost:3000/`
3. **Expected:** See warning page in your browser's language
4. Verify warning text is clearly visible
5. Verify "Continue" button is present

### 3.2 Accept Warning - Session Cookie

1. Click the "Continue" button on warning page
2. **Expected:** Redirected to proxied seznam-autobusu.cz content
3. Open DevTools (F12) → Application → Cookies
4. Verify `seznam_proxy_warned` cookie exists

### 3.3 Subsequent Visits - No Warning

1. Navigate to different path: `http://localhost:3000/vuz/663928`
2. **Expected:** Direct access to proxied content (no warning)
3. Warning should not appear again in same session

### 3.4 New Session - Warning Reappears

1. Clear all cookies OR close incognito window and open new one
2. Navigate to `http://localhost:3000/`
3. **Expected:** Warning page appears again

## 4. Path Preservation Tests

Verify all URL paths work correctly.

```bash
# Homepage
curl -L -b cookies.txt -c cookies.txt http://localhost:3000/

# Specific vehicle page
curl -L -b cookies.txt http://localhost:3000/vuz/663928

# Search query
curl -L -b cookies.txt "http://localhost:3000/hledat?q=test"

# Static assets
curl -L -b cookies.txt http://localhost:3000/static/css/style.css
```

**Expected Result:** All paths should work without errors.

## 5. Responsive Design Tests

### 5.1 Mobile View

1. Open `http://localhost:3000/` in browser
2. Press F12 to open DevTools
3. Click device toolbar icon (Ctrl+Shift+M)
4. Test different devices:
   - iPhone SE (375x667)
   - iPhone 12 Pro (390x844)
   - Pixel 5 (393x851)
   - iPad Air (820x1180)

**Expected Result:**
- Warning page is fully responsive
- No horizontal scrolling
- Text is readable
- Button is touch-friendly (min 48px height)
- Layout adjusts to screen size

### 5.2 Desktop View

Test on desktop resolutions:
- 1920x1080
- 1366x768
- 1280x720

**Expected Result:**
- Warning page is centered
- Maximum width constraint applied
- Professional appearance

## 6. URL Rewriting Tests

### 6.1 HTML Link Rewriting

1. Accept warning and navigate to homepage
2. Open DevTools → Network tab
3. Click any link on the page
4. **Expected:** All links go through proxy domain (not original domain)

### 6.2 CSS URL Rewriting

1. Open DevTools → Network tab
2. Filter by CSS
3. Open a CSS file and search for `url()`
4. **Expected:** All `url()` references point to proxy domain

### 6.3 Image Loading

1. Open homepage with DevTools → Network tab
2. Filter by Img
3. **Expected:** All images load through proxy domain

### 6.4 JavaScript Loading

1. Open DevTools → Network tab
2. Filter by JS
3. **Expected:** All JavaScript files load through proxy domain

## 7. Header Manipulation Tests

Verify proxy sends correct headers to target.

```bash
# Start a proxy debugging session
curl -v -L -b cookies.txt http://localhost:3000/ 2>&1 | grep -i "host\|referer\|origin"
```

**Expected Result:**
- Server manipulates headers internally
- Response contains proxy content

## 8. Rate Limiting Tests

Test that rate limiting prevents abuse.

```bash
# Send 110 requests rapidly (exceeds 100/minute limit)
for i in {1..110}; do
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/health
done | tail -20
```

**Expected Result:**
- First 100 requests: `200 OK`
- Requests 101+: `429 Too Many Requests`

## 9. Czech Proxy Pool Tests

`UPSTREAM_PROXY` is not read anywhere in `server.js` (leftover from an earlier
design) - the actual mechanism is the `PROXIES`/`WEBSHARE_PROXY_URL` pool.

### 9.1 Configure the Pool

Edit `.env`:
```env
PROXIES=proxy1.example.com:1080:user1:pass1,proxy2.example.com:1080:user2:pass2
# and/or
WEBSHARE_PROXY_URL=https://proxy.webshare.io/api/v2/proxy/list/download/<token>/-/any/username/backbone/-/
```

Restart server:
```bash
docker-compose restart
# OR
npm start
```

### 9.2 Verify Proxies Were Found

```bash
curl http://localhost:3000/health
curl http://localhost:3000/proxy-status
```

**Expected Result:** `/health` shows `"status": "ok"` and `"czechProxies" > 0`
once the startup health check finishes (`"proxyCheckInProgress": false`).
`/proxy-status` lists each Czech proxy's username, IP, and city.

### 9.3 Test Proxied Content

1. Accept warning
2. Navigate to any page
3. **Expected:** Content loads through one of the pool's Czech proxies (see
   server logs for `... -> <username> (<city>, <ip>) [session ...]`)

## 10. Error Handling Tests

### 10.1 Target Unreachable

1. Stop seznam-autobusu.cz connection (simulate by blocking DNS)
2. Try to access proxy
3. **Expected:** Error message: "Proxy error: Unable to reach seznam-autobusu.cz"

### 10.2 Invalid Proxy Entries

1. Add a bad entry to `PROXIES` in `.env` (wrong port/credentials)
2. Restart server
3. **Expected:** That entry fails its Czech-IP check and is logged/skipped;
   the server still starts and uses whatever other proxies did pass

## 11. Security Tests

### 11.1 CORS Headers

```bash
curl -H "Origin: https://evil.com" -H "Access-Control-Request-Method: GET" \
  -X OPTIONS http://localhost:3000/health -v
```

**Expected Result:** No CORS errors for health endpoint.

### 11.2 Security Headers

```bash
curl -I http://localhost:3000/health | grep -i "x-\|strict\|content-security"
```

**Expected Result:** Helmet security headers present.

## 12. Docker Tests

### 12.1 Build Image

```bash
docker-compose build
```

**Expected Result:** Build succeeds without errors.

### 12.2 Start Container

```bash
docker-compose up -d
```

**Expected Result:** Container starts successfully.

### 12.3 Check Container Health

```bash
docker-compose ps
```

**Expected Result:** Status shows "healthy" after 40 seconds.

### 12.4 View Logs

```bash
docker-compose logs
```

**Expected Result:** No error messages, server running.

### 12.5 Test Inside Container

```bash
docker-compose exec seznam-proxy wget -O- http://localhost:3000/health
```

**Expected Result:** Health check returns OK.

## 13. Performance Tests

### 13.1 Response Time

```bash
curl -w "\nTime: %{time_total}s\n" -o /dev/null -s http://localhost:3000/health
```

**Expected Result:** Response time < 1 second.

### 13.2 Compression Test

```bash
curl -H "Accept-Encoding: gzip" -I http://localhost:3000/ | grep -i "content-encoding"
```

**Expected Result:** `Content-Encoding: gzip` present.

## 14. Form Submission Test

1. Find a form on seznam-autobusu.cz (e.g., search form)
2. Fill out form and submit
3. **Expected:** Form submits through proxy correctly
4. Results appear normally

## 15. Cookie Persistence Test

### 15.1 Session Cookie

```bash
# Get warning page and save cookies
curl -c cookies.txt http://localhost:3000/ > /dev/null

# Accept warning
curl -b cookies.txt -c cookies.txt "http://localhost:3000/accept-warning?redirect=/" -L > /dev/null

# Verify no warning on subsequent request
curl -b cookies.txt http://localhost:3000/ | grep -q "VAROVÁNÍ" && echo "FAIL: Warning shown" || echo "PASS: No warning"
```

**Expected Result:** "PASS: No warning"

## Test Checklist

Copy and check off as you test:

- [ ] Health check returns 200 OK
- [ ] Czech users see Czech warning
- [ ] Slovak users see Czech warning
- [ ] Other users see English warning
- [ ] Warning page is responsive on mobile
- [ ] Warning page is responsive on desktop
- [ ] Continue button sets session cookie
- [ ] No warning on subsequent visits (same session)
- [ ] Warning reappears after clearing cookies
- [ ] All URL paths work correctly
- [ ] HTML links rewritten correctly
- [ ] CSS url() references rewritten
- [ ] Images load through proxy
- [ ] JavaScript loads through proxy
- [ ] Rate limiting works (429 after 100 requests)
- [ ] Docker build succeeds
- [ ] Docker container runs healthy
- [ ] Czech proxy pool populates (`/health` shows `czechProxies > 0`)
- [ ] Forms submit correctly
- [ ] Compression enabled
- [ ] Security headers present

## Troubleshooting Failed Tests

### Warning page not in correct language
- Check Accept-Language header is set correctly
- Verify server.js detectLanguage function

### Assets not loading
- Check browser console for errors
- Verify URL rewriting in server.js
- Check Network tab to see actual URLs being requested

### Rate limiting not working
- Wait 60 seconds for rate limit reset
- Check if requests are coming from same IP

### Docker tests failing
- Check Docker logs: `docker-compose logs`
- Verify .env file exists and is correct
- Ensure port 3000 is not in use

### Session cookie not persisting
- Check browser cookie settings
- Verify cookie is signed correctly
- Check COOKIE_SECRET in .env

## Automated Test Script

Create `test.sh`:

```bash
#!/bin/bash
echo "Running automated tests..."

# Test 1: Health check
echo -n "Test 1 - Health check: "
curl -s http://localhost:3000/health | grep -q "ok" && echo "PASS" || echo "FAIL"

# Test 2: Czech warning
echo -n "Test 2 - Czech warning: "
curl -s -H "Accept-Language: cs-CZ" http://localhost:3000/ | grep -q "DŮLEŽITÉ" && echo "PASS" || echo "FAIL"

# Test 3: English warning
echo -n "Test 3 - English warning: "
curl -s -H "Accept-Language: en-US" http://localhost:3000/ | grep -q "IMPORTANT" && echo "PASS" || echo "FAIL"

echo "Tests complete!"
```

Run with: `chmod +x test.sh && ./test.sh`

---

**Note:** Some tests require manual verification, especially UI/UX tests and responsive design checks.
