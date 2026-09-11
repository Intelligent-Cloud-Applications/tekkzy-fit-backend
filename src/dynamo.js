const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
} = require('@aws-sdk/lib-dynamodb');

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-2' }), {
  marshallOptions: { removeUndefinedValues: true },
});

const PROFILE = process.env.PROFILE_TABLE_NAME || 'beta_user_profile';
const PAYMENT = process.env.PAYMENT_TABLE_NAME || 'beta_payment';
const REPORT = process.env.REPORT_TABLE_NAME || 'beta_monthly_report';
const CODEGEN = process.env.CODEGEN_TABLE_NAME || 'code_generator_variables';
const codegenClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.CODEGEN_TABLE_REGION || 'us-east-1' }),
  { marshallOptions: { removeUndefinedValues: true } },
);

function fallbackInstitution() {
  return process.env.INSTITUTION || 'Fitnessworld001';
}

async function putProfile(item) {
  await client.send(new PutCommand({ TableName: PROFILE, Item: item }));
  return item;
}

async function getProfile(cognitoId, institution = fallbackInstitution()) {
  const out = await client.send(
    new GetCommand({ TableName: PROFILE, Key: { institution, cognitoId } }),
  );
  return out.Item || null;
}

async function deleteProfile(cognitoId, institution = fallbackInstitution()) {
  await client.send(
    new DeleteCommand({ TableName: PROFILE, Key: { institution, cognitoId } }),
  );
}

async function listProfiles(institution = fallbackInstitution()) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const out = await client.send(
      new QueryCommand({
        TableName: PROFILE,
        KeyConditionExpression: 'institution = :institution',
        ExpressionAttributeValues: { ':institution': institution },
        ExclusiveStartKey,
      }),
    );
    items.push(...(out.Items || []));
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items.filter((row) => {
    const id = String(row.cognitoId || '');
    if (id.startsWith('__')) return false;
    return !row.userType || row.userType === 'member' || row.source === institution;
  });
}

async function putPayment(item) {
  await client.send(new PutCommand({ TableName: PAYMENT, Item: item }));
  return item;
}

async function getPayment(cognitoId, paymentId) {
  const out = await client.send(
    new GetCommand({ TableName: PAYMENT, Key: { cognitoId, paymentId } }),
  );
  return out.Item || null;
}

async function listPaymentsByIndex(institution) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const out = await client.send(
      new QueryCommand({
        TableName: PAYMENT,
        IndexName: 'institution-paymentDate-index',
        KeyConditionExpression: 'institution = :institution',
        ExpressionAttributeValues: { ':institution': institution },
        ExclusiveStartKey,
        ScanIndexForward: false,
      }),
    );
    items.push(...(out.Items || []));
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function listPaymentsByScan(institution) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const out = await client.send(
      new ScanCommand({
        TableName: PAYMENT,
        FilterExpression: 'institution = :institution',
        ExpressionAttributeValues: { ':institution': institution },
        ExclusiveStartKey,
      }),
    );
    items.push(...(out.Items || []));
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items.sort((a, b) => Number(b.paymentDate || 0) - Number(a.paymentDate || 0));
}

async function listPayments(institution = fallbackInstitution()) {
  try {
    return await listPaymentsByIndex(institution);
  } catch (err) {
    const name = err?.name || '';
    if (name === 'ValidationException' || name === 'ResourceNotFoundException') {
      return listPaymentsByScan(institution);
    }
    throw err;
  }
}

async function paymentsForMember(cognitoId) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const out = await client.send(
      new QueryCommand({
        TableName: PAYMENT,
        KeyConditionExpression: 'cognitoId = :cognitoId',
        ExpressionAttributeValues: { ':cognitoId': cognitoId },
        ExclusiveStartKey,
      }),
    );
    items.push(...(out.Items || []));
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

const BRIDGE_ID = '__devicebridge__';
const CMD_PREFIX = '__devicecmd_';
const RES_PREFIX = '__deviceres_';
const PLAN_PREFIX = '__plan_';

async function queryPrefix(institution, prefix) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const out = await client.send(
      new QueryCommand({
        TableName: PROFILE,
        KeyConditionExpression: 'institution = :institution AND begins_with(cognitoId, :prefix)',
        ExpressionAttributeValues: { ':institution': institution, ':prefix': prefix },
        ExclusiveStartKey,
      }),
    );
    items.push(...(out.Items || []));
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function putBridge(institution, data) {
  return putProfile({
    institution,
    cognitoId: BRIDGE_ID,
    userType: 'device-bridge',
    ...data,
    updatedAt: new Date().toISOString(),
  });
}

async function getBridge(institution) {
  return getProfile(BRIDGE_ID, institution);
}

async function listDeviceCmds(institution) {
  return queryPrefix(institution, CMD_PREFIX);
}

async function getDeviceResult(institution, id) {
  return getProfile(`${RES_PREFIX}${id}`, institution);
}

function planKey(id) {
  return `${PLAN_PREFIX}${String(id || '').trim()}`;
}

async function listPlans(institution) {
  return queryPrefix(institution, PLAN_PREFIX);
}

async function getPlan(institution, id) {
  return getProfile(planKey(id), institution);
}

async function putPlan(item) {
  return putProfile(item);
}

async function deletePlan(institution, id) {
  return deleteProfile(planKey(id), institution);
}

async function listReports(institution) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const out = await client.send(
      new QueryCommand({
        TableName: REPORT,
        KeyConditionExpression: 'institution = :institution',
        ExpressionAttributeValues: { ':institution': institution },
        ExclusiveStartKey,
      }),
    );
    items.push(...(out.Items || []));
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function getReport(institution, monthKey) {
  const out = await client.send(
    new GetCommand({ TableName: REPORT, Key: { institution, cognitoIdAndMonth: monthKey } }),
  );
  return out.Item || null;
}

async function putReport(item) {
  await client.send(new PutCommand({ TableName: REPORT, Item: item }));
  return item;
}

async function getCodegen(institution) {
  const out = await codegenClient.send(
    new GetCommand({
      TableName: CODEGEN,
      Key: { institutionid: institution, index: '0' },
    }),
  );
  return out.Item || null;
}

async function putCodegen(item) {
  await codegenClient.send(new PutCommand({ TableName: CODEGEN, Item: item }));
  return item;
}

module.exports = {
  fallbackInstitution,
  putProfile,
  getProfile,
  deleteProfile,
  listProfiles,
  putPayment,
  getPayment,
  listPayments,
  paymentsForMember,
  BRIDGE_ID,
  CMD_PREFIX,
  RES_PREFIX,
  PLAN_PREFIX,
  putBridge,
  getBridge,
  listDeviceCmds,
  getDeviceResult,
  listPlans,
  getPlan,
  putPlan,
  deletePlan,
  listReports,
  getReport,
  putReport,
  getCodegen,
  putCodegen,
};
