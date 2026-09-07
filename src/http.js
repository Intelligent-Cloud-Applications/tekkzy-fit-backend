const ALLOW_HEADERS = 'Content-Type,Authorization,X-Gym-Key,X-Institution,X-Razorpay-Signature';

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...cors(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function parseBody(event) {
  if (!event.body) return {};
  if (event.isBase64Encoded) {
    return JSON.parse(Buffer.from(event.body, 'base64').toString('utf8') || '{}');
  }
  return typeof event.body === 'string' ? JSON.parse(event.body || '{}') : event.body;
}

function rawBody(event) {
  if (!event.body) return '';
  if (event.isBase64Encoded) return Buffer.from(event.body, 'base64').toString('utf8');
  return typeof event.body === 'string' ? event.body : JSON.stringify(event.body);
}

function header(event, name) {
  const headers = event.headers || {};
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key]) : '';
}

function requireGymKey(event) {
  const expected = String(process.env.GYM_API_KEY || '').trim();
  if (!expected) return true;
  return header(event, 'x-gym-key') === expected;
}

function pathId(event) {
  return event.pathParameters?.id || '';
}

function method(event) {
  return String(event.httpMethod || event.requestContext?.http?.method || 'GET').toUpperCase();
}

function institutionFrom(event, body = {}) {
  const query = event.queryStringParameters || {};
  const value = header(event, 'x-institution')
    || body.institution
    || body.institutionId
    || query.institution
    || query.institutionId
    || process.env.INSTITUTION
    || 'Fitnessworld001';
  return String(value).trim();
}

module.exports = { cors, json, parseBody, rawBody, header, requireGymKey, pathId, method, institutionFrom };
