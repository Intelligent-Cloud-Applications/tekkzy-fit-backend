import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';

const INSTITUTIONS = ['Fitnessworld001', 'tekkzyfit'];
const REGION = 'us-east-2';
const PROFILE = 'beta_user_profile';
const PAYMENT = 'beta_payment';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

async function allByInstitution(table, indexName) {
  const items = [];
  for (const institution of INSTITUTIONS) {
    let ExclusiveStartKey;
    do {
      const out = await db.send(
        new QueryCommand({
          TableName: table,
          IndexName: indexName,
          KeyConditionExpression: 'institution = :institution',
          ExpressionAttributeValues: { ':institution': institution },
          ExclusiveStartKey,
        }),
      );
      items.push(...(out.Items || []));
      ExclusiveStartKey = out.LastEvaluatedKey;
    } while (ExclusiveStartKey);
  }
  return items;
}

const profiles = await allByInstitution(PROFILE);
const payments = await allByInstitution(PAYMENT, 'institution-paymentDate-index');

console.log(`profiles ${profiles.length}`, profiles.map((p) => `${p.institution}/${p.cognitoId}/${p.userName || p.emailId || ''}`));
console.log(`payments ${payments.length}`, payments.map((p) => `${p.institution}/${p.paymentId}`));

for (const row of profiles) {
  await db.send(new DeleteCommand({ TableName: PROFILE, Key: { institution: row.institution, cognitoId: row.cognitoId } }));
}
for (const row of payments) {
  await db.send(new DeleteCommand({ TableName: PAYMENT, Key: { cognitoId: row.cognitoId, paymentId: row.paymentId } }));
}

console.log(`deleted ${profiles.length} profiles, ${payments.length} payments`);
