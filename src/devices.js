const { json, parseBody, requireGymKey, method, institutionFrom, cors } = require('./http');
const dynamo = require('./dynamo');

const OFFLINE = {
  users: [],
  logs: [],
  offline: true,
  ok: false,
  passwordSet: false,
  host: '',
  username: '',
  laptopIps: [],
  hostOnThisWifi: true,
  laptopServer: false,
  laptopServerMessage:
    'Turn on the gym computer. It connects to the face terminal by itself. Then this website works on phones and other computers.',
  message:
    'Turn on the gym computer. It connects to the face terminal by itself. Then this website works on phones and other computers.',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function proxyPath(event) {
  return String(event.pathParameters?.proxy || '').replace(/^\/+/, '');
}

function newCmdId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function isBridgeFresh(row) {
  if (!row?.updatedAt) return false;
  return Date.now() - new Date(row.updatedAt).getTime() < 90_000;
}

function queryString(event) {
  const params = event.queryStringParameters || {};
  const entries = Object.entries(params).filter(([, value]) => value != null);
  if (!entries.length) return '';
  return `?${new URLSearchParams(entries).toString()}`;
}

function photoResponse(payload) {
  if (!payload || !payload.__photo || !payload.base64) return null;
  return {
    statusCode: 200,
    headers: { ...cors(), 'Content-Type': payload.contentType || 'image/jpeg' },
    body: payload.base64,
    isBase64Encoded: true,
  };
}

function reply(statusCode, payload) {
  return photoResponse(payload) || json(statusCode, payload);
}

async function saveHeartbeat(institution, body) {
  await dynamo.putBridge(institution, {
    host: body.host || '',
    username: body.username || '',
    passwordSet: Boolean(body.passwordSet),
    laptopIps: Array.isArray(body.laptopIps) ? body.laptopIps : [],
    hostOnThisWifi: Boolean(body.hostOnThisWifi),
    deviceOnline: Object.prototype.hasOwnProperty.call(body, 'deviceOnline')
      ? Boolean(body.deviceOnline)
      : Boolean(body.hostOnThisWifi),
    scanning: Boolean(body.scanning),
  });
}

async function nextCommand(institution) {
  const rows = (await dynamo.listDeviceCmds(institution))
    .filter((row) => row.cmdStatus === 'pending')
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

  for (const row of rows) {
    const age = Date.now() - new Date(row.createdAt || 0).getTime();
    if (age > 45_000) {
      await dynamo.deleteProfile(row.cognitoId, institution);
      continue;
    }
    await dynamo.putProfile({ ...row, cmdStatus: 'claimed', claimedAt: new Date().toISOString() });
    return {
      id: String(row.cognitoId).slice(dynamo.CMD_PREFIX.length),
      method: row.httpMethod || 'GET',
      path: row.path,
      body: row.body || {},
      query: row.query || '',
    };
  }
  return null;
}

async function handleBridge(event, path, body, institution) {
  if (!requireGymKey(event)) return json(401, { error: 'Unauthorized' });

  if (path === 'bridge/heartbeat') {
    await saveHeartbeat(institution, body);
    return json(200, { ok: true });
  }

  if (path === 'bridge/next') {
    await saveHeartbeat(institution, body);
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const command = await nextCommand(institution);
      if (command) return json(200, { command });
      await sleep(700);
    }
    return json(200, { command: null });
  }

  if (path === 'bridge/result') {
    const id = String(body.id || '').trim();
    if (!id) return json(400, { error: 'Missing id' });
    await dynamo.putProfile({
      institution,
      cognitoId: `${dynamo.RES_PREFIX}${id}`,
      userType: 'device-bridge',
      statusCode: Number(body.statusCode || 200),
      payload: body.payload ?? {},
      createdAt: new Date().toISOString(),
    });
    await dynamo.deleteProfile(`${dynamo.CMD_PREFIX}${id}`, institution).catch(() => undefined);
    return json(200, { ok: true });
  }

  if (path === 'bridge/expiry-applied') {
    const enroll = String(body.enroll || '').trim();
    const cognitoId = String(body.cognitoId || '').trim();
    const deviceEnd = String(body.deviceEnd || '').trim();
    let profile = cognitoId ? await dynamo.getProfile(cognitoId, institution) : null;
    if (!profile && enroll) {
      profile = (await dynamo.listProfiles(institution)).find((row) => String(row.deviceEnrollId || '').trim() === enroll) || null;
    }
    if (!profile) return json(404, { error: 'Member not found' });
    await dynamo.putProfile({
      ...profile,
      deviceEnd: deviceEnd || profile.deviceEnd || profile.renewDate,
      deviceEndPending: false,
      updatedAt: Date.now(),
      updatedAtIso: new Date().toISOString(),
    });
    return json(200, { ok: true });
  }

  return json(404, { error: 'Unknown bridge path' });
}

async function waitForResult(institution, id, verb, maxMs = 26_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const row = await dynamo.getDeviceResult(institution, id);
    if (row) {
      await dynamo.deleteProfile(`${dynamo.RES_PREFIX}${id}`, institution).catch(() => undefined);
      await dynamo.deleteProfile(`${dynamo.CMD_PREFIX}${id}`, institution).catch(() => undefined);
      return reply(Number(row.statusCode || 200), row.payload ?? {});
    }
    await sleep(400);
  }
  await dynamo.deleteProfile(`${dynamo.CMD_PREFIX}${id}`, institution).catch(() => undefined);
  return json(verb === 'GET' ? 200 : 503, { ...OFFLINE, error: OFFLINE.message });
}

async function relayLive(event, path, body, institution) {
  const verb = method(event);
  const bridge = await dynamo.getBridge(institution);
  if (!isBridgeFresh(bridge)) {
    const stale = {
      ...OFFLINE,
      host: bridge?.host || '',
      username: bridge?.username || '',
      passwordSet: Boolean(bridge?.passwordSet),
      laptopIps: Array.isArray(bridge?.laptopIps) ? bridge.laptopIps : [],
    };
    return json(verb === 'GET' ? 200 : 503, stale);
  }

  if (verb === 'GET' && path === 'live/config') {
    return json(200, {
      host: bridge.host || '',
      username: bridge.username || '',
      passwordSet: Boolean(bridge.passwordSet),
      laptopIps: Array.isArray(bridge.laptopIps) ? bridge.laptopIps : [],
      hostOnThisWifi: Boolean(bridge.hostOnThisWifi),
      deviceOnline: Boolean(bridge.deviceOnline),
      scanning: Boolean(bridge.scanning),
      laptopServer: true,
    });
  }

  const id = newCmdId();
  await dynamo.putProfile({
    institution,
    cognitoId: `${dynamo.CMD_PREFIX}${id}`,
    userType: 'device-bridge',
    cmdStatus: 'pending',
    httpMethod: verb,
    path: `/devices/${path}`,
    query: queryString(event),
    body,
    createdAt: new Date().toISOString(),
  });
  const waitMs = path === 'live/reg-status' ? 8_000 : 26_000;
  return waitForResult(institution, id, verb, waitMs);
}

exports.handler = async (event) => {
  if (method(event) === 'OPTIONS') return json(200, { ok: true });
  const path = proxyPath(event);
  let body = {};
  try {
    body = parseBody(event);
  } catch {
    body = {};
  }
  const institution = institutionFrom(event, body);
  if (path.startsWith('bridge/')) return handleBridge(event, path, body, institution);
  if (path.startsWith('live/')) return relayLive(event, path, body, institution);
  return json(200, OFFLINE);
};
