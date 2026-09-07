const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
} = require('@aws-sdk/lib-dynamodb');

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-2' }), {
  marshallOptions: { removeUndefinedValues: true },
});

const PROFILE = process.env.PROFILE_TABLE_NAME || 'beta_user_profile';
const PAYMENT = process.env.PAYMENT_TABLE_NAME || 'beta_payment';

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
  return items.filter((row) => !row.userType || row.userType === 'member' || row.source === institution);
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

async function listPayments(institution = fallbackInstitution()) {
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
  putBridge,
  getBridge,
  listDeviceCmds,
  getDeviceResult,
};
