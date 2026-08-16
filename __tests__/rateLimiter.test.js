const request = require('supertest');
const app = require('../server');

describe('rate limiter', () => {
  test('rejects with 429 after 100 requests/minute from the same IP', async () => {
    let lastStatus = 200;
    for (let i = 0; i < 105; i++) {
      const res = await request(app).get('/health');
      lastStatus = res.status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  }, 30000);
});
