import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseKeywords,
  matchGateway,
  checkGatewayAlive,
  canLaunch,
  recordLaunch,
  extractModelFromDomText
} from '../../../plugins/gateway-keeper/lib.js';

test('parseKeywords: splits on english/chinese commas, semicolons, and newlines', () => {
  const input = 'gemini, claude-opus，claude-sonnet-5; gpt-oss；google\nmagpie\r\nzcode/';
  const result = parseKeywords(input);
  assert.deepEqual(result, [
    'gemini',
    'claude-opus',
    'claude-sonnet-5',
    'gpt-oss',
    'google',
    'magpie',
    'zcode/'
  ]);
});

test('parseKeywords: normalizes lowercase, trims whitespace, and skips empty tokens', () => {
  const input = '  Gemini-Pro  , ， ; \n \r\n  CLAUDE-3.5-SONNET  ;； ';
  const result = parseKeywords(input);
  assert.deepEqual(result, ['gemini-pro', 'claude-3.5-sonnet']);
});

test('parseKeywords: returns empty array for empty, null, or invalid inputs', () => {
  assert.deepEqual(parseKeywords(''), []);
  assert.deepEqual(parseKeywords('   '), []);
  assert.deepEqual(parseKeywords(null), []);
  assert.deepEqual(parseKeywords(undefined), []);
  assert.deepEqual(parseKeywords(12345), []);
  assert.deepEqual(parseKeywords({}), []);
});

test('matchGateway: correctly matches model name to enabled gateway', () => {
  const gateways = [
    {
      id: 'antigravity-tools',
      name: 'Antigravity Tools',
      enabled: true,
      path: 'D:\\Tools\\antigravity-tools.exe',
      url: 'http://127.0.0.1:8045',
      keywords: 'gemini, claude-opus, claude-sonnet-5, gpt-oss, google'
    },
    {
      id: 'magpie',
      name: 'Magpie',
      enabled: true,
      path: 'C:\\Programs\\magpie.exe',
      url: 'http://127.0.0.1:3425',
      keywords: 'magpie, zcode/'
    }
  ];

  // Case insensitive match
  const match1 = matchGateway('Google Gemini 2.5 Pro', gateways);
  assert.equal(match1?.id, 'antigravity-tools');

  const match2 = matchGateway('CLAUDE-OPUS-4', gateways);
  assert.equal(match2?.id, 'antigravity-tools');

  const match3 = matchGateway('zcode/deepseek-v3', gateways);
  assert.equal(match3?.id, 'magpie');

  // No match
  const noMatch = matchGateway('openai/gpt-4o', gateways);
  assert.equal(noMatch, null);
});

test('matchGateway: skips disabled gateways and supports keywords array', () => {
  const gateways = [
    {
      id: 'disabled-gw',
      name: 'Disabled Gateway',
      enabled: false,
      keywords: ['gemini', 'google']
    },
    {
      id: 'enabled-gw',
      name: 'Enabled Gateway',
      enabled: true,
      keywords: ['gemini', 'custom']
    }
  ];

  const matched = matchGateway('gemini-2.5-flash', gateways);
  assert.equal(matched?.id, 'enabled-gw');
});

test('matchGateway: returns null for invalid model names or empty gateway lists', () => {
  assert.equal(matchGateway('', [{ id: 'a', enabled: true, keywords: 'a' }]), null);
  assert.equal(matchGateway('   ', [{ id: 'a', enabled: true, keywords: 'a' }]), null);
  assert.equal(matchGateway(null, [{ id: 'a', enabled: true, keywords: 'a' }]), null);
  assert.equal(matchGateway('gemini', null), null);
  assert.equal(matchGateway('gemini', []), null);
});

test('checkGatewayAlive: reports alive when HTTP status is between 200 and 499', async () => {
  // HTTP 200 OK
  const fetch200 = async () => ({ ok: true, status: 200, text: 'OK' });
  const r200 = await checkGatewayAlive('http://127.0.0.1:8045', fetch200);
  assert.equal(r200.alive, true);
  assert.equal(r200.status, 200);

  // HTTP 404 (port listening and service responded)
  const fetch404 = async () => ({ ok: false, status: 404, text: 'Not Found' });
  const r404 = await checkGatewayAlive('http://127.0.0.1:8045', fetch404);
  assert.equal(r404.alive, true);
  assert.equal(r404.status, 404);

  // HTTP 401 Unauthorized (port listening)
  const fetch401 = async () => ({ ok: false, status: 401, text: 'Unauthorized' });
  const r401 = await checkGatewayAlive('http://127.0.0.1:8045', fetch401);
  assert.equal(r401.alive, true);
  assert.equal(r401.status, 401);
});

test('checkGatewayAlive: reports offline on connection error or 500 error', async () => {
  // Connection refused
  const fetchRefused = async () => ({
    ok: false,
    status: 0,
    error: 'connect ECONNREFUSED 127.0.0.1:8045'
  });
  const rRefused = await checkGatewayAlive('http://127.0.0.1:8045', fetchRefused);
  assert.equal(rRefused.alive, false);
  assert.match(rRefused.error, /ECONNREFUSED/);

  // HTTP 500 Internal Server Error
  const fetch500 = async () => ({ ok: false, status: 500, error: 'Internal Error' });
  const r500 = await checkGatewayAlive('http://127.0.0.1:8045', fetch500);
  assert.equal(r500.alive, false);

  // Exception thrown
  const fetchThrow = async () => {
    throw new Error('fetch timeout');
  };
  const rThrow = await checkGatewayAlive('http://127.0.0.1:8045', fetchThrow);
  assert.equal(rThrow.alive, false);
  assert.equal(rThrow.error, 'fetch timeout');

  // Invalid params
  const rInvalid = await checkGatewayAlive('', null);
  assert.equal(rInvalid.alive, false);
  assert.equal(rInvalid.error, 'invalid_params');
});

test('canLaunch & recordLaunch: correctly handles cooldown window', () => {
  const map = {};
  const gwId = 'antigravity-tools';
  const cooldownMs = 15000;
  const t0 = 100000;

  // First launch allowed
  assert.equal(canLaunch(gwId, map, cooldownMs, t0), true);

  // Record launch at t0
  recordLaunch(gwId, map, t0);
  assert.equal(map[gwId], t0);

  // Inside cooldown window (t0 + 5000)
  assert.equal(canLaunch(gwId, map, cooldownMs, t0 + 5000), false);

  // Boundary check (t0 + 14999)
  assert.equal(canLaunch(gwId, map, cooldownMs, t0 + 14999), false);

  // Cooldown elapsed (t0 + 15000)
  assert.equal(canLaunch(gwId, map, cooldownMs, t0 + 15000), true);

  // Cooldown well elapsed (t0 + 20000)
  assert.equal(canLaunch(gwId, map, cooldownMs, t0 + 20000), true);

  // Different gateway ID is unaffected
  assert.equal(canLaunch('magpie', map, cooldownMs, t0 + 5000), true);
});

test('extractModelFromDomText: removes control characters and normalizes whitespace', () => {
  // Whitespace and newlines normalization
  const text1 = '  Google \n  Gemini 2.5 Pro \r\n (Thinking) \t ';
  assert.equal(extractModelFromDomText(text1), 'Google Gemini 2.5 Pro (Thinking)');

  // Control characters
  const text2 = 'Claude-3.7-Sonnet\u0000\u0007\u001b[31m';
  assert.equal(extractModelFromDomText(text2), 'Claude-3.7-Sonnet[31m');

  // Empty or non-string inputs
  assert.equal(extractModelFromDomText(''), '');
  assert.equal(extractModelFromDomText('   '), '');
  assert.equal(extractModelFromDomText(null), '');
  assert.equal(extractModelFromDomText(undefined), '');
  assert.equal(extractModelFromDomText(123), '');
});
