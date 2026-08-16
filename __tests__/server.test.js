const request = require('supertest');
const app = require('../server');
const {
  rewriteUrl,
  rewriteUrlsInText,
  rewriteHtml,
  rewriteCss,
  stripCookieDomain,
  detectLanguage,
  pickProxyForSession,
  proxyKey,
  proxyLabel
} = app._internal;

describe('proxyKey', () => {
  test('is based on host:port, not username/password', () => {
    const a = { host: '1.2.3.4', port: '8888', username: undefined, password: undefined };
    const b = { host: '1.2.3.4', port: '8888', username: 'someone-else', password: 'pw' };
    expect(proxyKey(a)).toBe('1.2.3.4:8888');
    expect(proxyKey(a)).toBe(proxyKey(b));
  });

  test('distinguishes two credential-less proxies on different hosts (e.g. two tinyproxy boxes)', () => {
    const a = { host: '1.2.3.4', port: '8888', username: undefined, password: undefined };
    const b = { host: '5.6.7.8', port: '8888', username: undefined, password: undefined };
    expect(proxyKey(a)).not.toBe(proxyKey(b));
  });
});

describe('proxyLabel', () => {
  test('uses the username when present', () => {
    expect(proxyLabel({ host: '1.2.3.4', port: '8888', username: 'brd-customer-x' }))
      .toBe('brd-customer-x');
  });

  test('falls back to host:port for credential-less proxies', () => {
    expect(proxyLabel({ host: '1.2.3.4', port: '8888', username: undefined }))
      .toBe('1.2.3.4:8888');
  });
});

describe('stripCookieDomain', () => {
  test('removes a Domain attribute so the cookie scopes to the proxy host', () => {
    expect(stripCookieDomain('sid=abc123; Domain=seznam-autobusu.cz; Path=/'))
      .toBe('sid=abc123; Path=/');
  });

  test('leaves cookies without a Domain attribute untouched', () => {
    expect(stripCookieDomain('sid=abc123; Path=/; HttpOnly'))
      .toBe('sid=abc123; Path=/; HttpOnly');
  });
});

describe('pickProxyForSession', () => {
  test('returns null when the proxy pool is empty', () => {
    expect(pickProxyForSession('some-session-id')).toBeNull();
  });
});

describe('detectLanguage', () => {
  test('detects Czech', () => {
    expect(detectLanguage({ headers: { 'accept-language': 'cs-CZ,cs;q=0.9' } })).toBe('cs');
  });

  test('detects Slovak as Czech warning', () => {
    expect(detectLanguage({ headers: { 'accept-language': 'sk-SK,sk;q=0.9' } })).toBe('cs');
  });

  test('defaults other languages to English', () => {
    expect(detectLanguage({ headers: { 'accept-language': 'de-DE,de;q=0.9' } })).toBe('en');
    expect(detectLanguage({ headers: { 'accept-language': 'fr-FR,fr;q=0.9' } })).toBe('en');
  });

  test('handles missing header', () => {
    expect(detectLanguage({ headers: {} })).toBe('en');
  });
});

describe('rewriteUrl', () => {
  const host = 'proxy.example.com';

  test('rewrites absolute https URLs', () => {
    expect(rewriteUrl('https://seznam-autobusu.cz/vuz/123', host))
      .toBe('https://proxy.example.com/vuz/123');
  });

  test('rewrites absolute http URLs to https on the proxy host', () => {
    expect(rewriteUrl('http://seznam-autobusu.cz/vuz/123', host))
      .toBe('https://proxy.example.com/vuz/123');
  });

  test('rewrites protocol-relative URLs', () => {
    expect(rewriteUrl('//seznam-autobusu.cz/static/app.js', host))
      .toBe('//proxy.example.com/static/app.js');
  });

  test('leaves unrelated URLs untouched', () => {
    expect(rewriteUrl('https://example.com/foo', host)).toBe('https://example.com/foo');
    expect(rewriteUrl('/relative/path', host)).toBe('/relative/path');
  });

  test('passes through falsy input', () => {
    expect(rewriteUrl('', host)).toBe('');
    expect(rewriteUrl(null, host)).toBe(null);
  });
});

describe('rewriteUrlsInText', () => {
  const host = 'proxy.example.com';

  test('rewrites a URL embedded inside meta-refresh style content', () => {
    expect(rewriteUrlsInText('5;url=https://seznam-autobusu.cz/foo', host))
      .toBe('5;url=https://proxy.example.com/foo');
  });

  test('rewrites protocol-relative URLs embedded in text', () => {
    expect(rewriteUrlsInText('see //seznam-autobusu.cz/bar', host))
      .toBe('see //proxy.example.com/bar');
  });
});

describe('rewriteCss', () => {
  const host = 'proxy.example.com';

  test('rewrites url() references', () => {
    const css = `.bg { background: url('https://seznam-autobusu.cz/img/bg.png'); }`;
    expect(rewriteCss(css, host)).toBe(`.bg { background: url('https://proxy.example.com/img/bg.png'); }`);
  });

  test('leaves unrelated url() references untouched', () => {
    const css = `.bg { background: url('https://other.com/img/bg.png'); }`;
    expect(rewriteCss(css, host)).toContain('https://other.com/img/bg.png');
  });
});

describe('rewriteHtml', () => {
  const host = 'proxy.example.com';
  const fakeReq = { headers: { 'accept-language': 'en-US' } };

  test('rewrites href, src, action, and srcset', () => {
    const html = `<html><body>
      <a href="https://seznam-autobusu.cz/vuz/1">link</a>
      <form action="https://seznam-autobusu.cz/hledat"></form>
      <img src="https://seznam-autobusu.cz/img/1.png" srcset="https://seznam-autobusu.cz/img/1x.png 1x, https://seznam-autobusu.cz/img/2x.png 2x">
    </body></html>`;
    const out = rewriteHtml(html, host, fakeReq);

    expect(out).toContain('href="https://proxy.example.com/vuz/1"');
    expect(out).toContain('action="https://proxy.example.com/hledat"');
    expect(out).toContain('src="https://proxy.example.com/img/1.png"');
    expect(out).toContain('proxy.example.com/img/1x.png 1x');
    expect(out).toContain('proxy.example.com/img/2x.png 2x');
  });

  test('rewrites inline style url()', () => {
    const html = `<div style="background:url(https://seznam-autobusu.cz/img/bg.png)"></div>`;
    const out = rewriteHtml(html, host, fakeReq);
    expect(out).toContain("proxy.example.com/img/bg.png");
  });

  test('rewrites meta-refresh redirects', () => {
    const html = `<meta http-equiv="refresh" content="0;url=https://seznam-autobusu.cz/redirected">`;
    const out = rewriteHtml(html, host, fakeReq);
    expect(out).toContain('content="0;url=https://proxy.example.com/redirected"');
  });

  test('injects the warning overlay button', () => {
    const out = rewriteHtml('<html><body>hi</body></html>', host, fakeReq);
    expect(out).toContain('proxy-warning-overlay-btn');
  });
});

describe('GET /health', () => {
  test('returns 200 with a status payload regardless of proxy pool state', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('czechProxies');
  });
});

describe('GET /metrics', () => {
  test('exposes prometheus-style counters', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('seznam_proxy_requests_total');
    expect(res.text).toContain('seznam_proxy_czech_proxies');
  });
});

describe('GET /accept-warning', () => {
  test('sets the warning cookie and redirects', async () => {
    const res = await request(app).get('/accept-warning?redirect=/somewhere');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/somewhere');
    expect(res.headers['set-cookie'].some(c => c.startsWith('seznam_proxy_warned='))).toBe(true);
  });

  test('defaults redirect target to /', async () => {
    const res = await request(app).get('/accept-warning');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });
});

describe('warning gate', () => {
  test('serves a 503 (not the raw warning page) when no proxies are configured', async () => {
    // In the test env checkAllProxies() never ran, so the pool is empty.
    const res = await request(app).get('/vuz/123');
    expect(res.status).toBe(503);
  });
});
