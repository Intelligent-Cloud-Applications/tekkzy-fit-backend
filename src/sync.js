const { json, parseBody, requireGymKey, method, institutionFrom } = require('./http');
const dynamo = require('./dynamo');
const { toMember } = require('./map');

exports.handler = async (event) => {
  if (method(event) === 'OPTIONS') return json(200, { ok: true });
  if (!requireGymKey(event)) return json(401, { error: 'Unauthorized' });

  const verb = method(event);
  const path = String(event.path || event.rawPath || event.resource || '');
  const institution = institutionFrom(event, verb === 'GET' ? {} : parseBody(event));

  try {
    if (verb === 'POST' && path.includes('push')) {
      return json(200, { ok: true });
    }
    if (verb === 'GET' && path.includes('pull')) {
      const rows = await dynamo.listProfiles(institution);
      return json(200, [{ entity: 'members', records: rows.map(toMember) }]);
    }
    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('sync', err);
    return json(500, { error: err instanceof Error ? err.message : 'Server error' });
  }
};
