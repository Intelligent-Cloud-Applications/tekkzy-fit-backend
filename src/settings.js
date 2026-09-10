const { json, parseBody, method, institutionFrom } = require('./http');
const dynamo = require('./dynamo');

const DEFAULTS = {
  id: 'settings-1',
  gymName: '',
  legalName: '',
  phone: '',
  email: '',
  address: '',
  city: '',
  state: '',
  pincode: '',
  gstin: '',
  gateUnlockDurationSeconds: 5,
  duplicateScanCooldownSeconds: 30,
  allowExpired: false,
  allowSuspended: false,
  unknownFacePolicy: 'DENY',
  offlineModeEnabled: true,
  reminderDays: [7, 3, 2, 1, 0],
  currency: 'INR',
  timezone: 'Asia/Kolkata',
};

function info(row) {
  return row?.companyInfo && typeof row.companyInfo === 'object' ? row.companyInfo : {};
}

function toSettings(row) {
  const extra = info(row);
  return {
    ...DEFAULTS,
    gymName: String(row.companyName || extra.companyName || ''),
    legalName: String(row.legalName || extra.legalName || row.companyName || extra.companyName || ''),
    phone: String(row.phoneNumber || row.Query_PhoneNumber || extra.ownerPhonenumber || ''),
    email: String(row.emailId || row.Query_EmailId || extra.ownerEmail || ''),
    address: String(row.address || row.Query_Address || extra.address || ''),
    city: String(row.city || extra.city || ''),
    state: String(row.state || extra.state || ''),
    pincode: String(row.pincode || extra.pincode || ''),
    gstin: String(row.gstin || extra.gstin || ''),
    gateUnlockDurationSeconds: Number(row.gateUnlockDurationSeconds ?? DEFAULTS.gateUnlockDurationSeconds),
    duplicateScanCooldownSeconds: Number(row.duplicateScanCooldownSeconds ?? DEFAULTS.duplicateScanCooldownSeconds),
    allowExpired: Boolean(row.allowExpired),
    allowSuspended: Boolean(row.allowSuspended),
    unknownFacePolicy: row.unknownFacePolicy === 'ALLOW' ? 'ALLOW' : 'DENY',
    offlineModeEnabled: row.offlineModeEnabled !== false,
    reminderDays: Array.isArray(row.reminderDays) ? row.reminderDays.map(Number) : DEFAULTS.reminderDays,
    currency: row.currency || DEFAULTS.currency,
    timezone: row.timezone || DEFAULTS.timezone,
  };
}

function fromSettings(institution, body, previous) {
  const gymName = String(body.gymName || '').trim();
  const legalName = String(body.legalName || gymName).trim();
  const phone = String(body.phone || '').trim();
  const email = String(body.email || '').trim();
  const address = String(body.address || '').trim();
  const city = String(body.city || '').trim();
  const state = String(body.state || '').trim();
  const pincode = String(body.pincode || '').trim();
  const gstin = String(body.gstin || '').trim();
  const now = new Date().toISOString();
  return {
    ...(previous || {}),
    institutionid: institution,
    index: '0',
    companyName: gymName,
    legalName,
    phoneNumber: phone,
    emailId: email,
    address,
    city,
    state,
    pincode,
    gstin,
    Query_PhoneNumber: phone,
    Query_EmailId: email,
    Query_Address: address,
    companyInfo: {
      ...(info(previous)),
      companyName: gymName,
      legalName,
      ownerPhonenumber: phone,
      ownerEmail: email,
      address,
      city,
      state,
      pincode,
      gstin,
    },
    institutionType: previous?.institutionType || 'gym',
    status: previous?.status || 'Active',
    isFormFilled: true,
    gateUnlockDurationSeconds: Number(body.gateUnlockDurationSeconds ?? previous?.gateUnlockDurationSeconds ?? 5),
    duplicateScanCooldownSeconds: Number(body.duplicateScanCooldownSeconds ?? previous?.duplicateScanCooldownSeconds ?? 30),
    allowExpired: Boolean(body.allowExpired),
    allowSuspended: Boolean(body.allowSuspended),
    unknownFacePolicy: body.unknownFacePolicy === 'ALLOW' ? 'ALLOW' : 'DENY',
    offlineModeEnabled: body.offlineModeEnabled !== false,
    reminderDays: Array.isArray(body.reminderDays) ? body.reminderDays.map(Number) : (previous?.reminderDays || [7, 3, 1, 0]),
    currency: body.currency || previous?.currency || 'INR',
    timezone: body.timezone || previous?.timezone || 'Asia/Kolkata',
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  };
}

exports.handler = async (event) => {
  if (method(event) === 'OPTIONS') return json(200, { ok: true });
  let body = {};
  try {
    body = parseBody(event);
  } catch {
    body = {};
  }
  const institution = institutionFrom(event, body);
  const verb = method(event);

  try {
    if (verb === 'GET') {
      const row = await dynamo.getCodegen(institution);
      return json(200, row ? toSettings(row) : {
        ...DEFAULTS,
        gymName: 'IronWorks Fitness',
        legalName: 'IronWorks Fitness Pvt Ltd',
        phone: '+91 80 4123 7788',
        email: 'front@ironworks.fit',
        address: '14, 100 Feet Road, Indiranagar',
        city: 'Bengaluru',
        state: 'Karnataka',
        pincode: '560038',
        gstin: '29AABCI1234M1Z5',
      });
    }

    if (verb === 'PUT' || verb === 'POST' || verb === 'PATCH') {
      const previous = await dynamo.getCodegen(institution);
      const saved = await dynamo.putCodegen(fromSettings(institution, body, previous));
      return json(200, toSettings(saved));
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('settings', err);
    return json(500, { error: err instanceof Error ? err.message : 'Server error' });
  }
};
