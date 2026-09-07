# Tekkzy Fit backend

AWS Lambda + API Gateway (`tekkzy-fit-api`, `us-east-2`).

## Stages

| Branch | Serverless stage | Tables | Razorpay |
| --- | --- | --- | --- |
| `beta` | `dev` | `beta_user_profile`, `beta_payment` | test |
| `prod` | `prod` | `userprofile`, `payments` | live |

## Deploy

Copy `.env.example` to `.env` and fill keys. Never commit `.env`.

```bash
npm install
npx serverless deploy --stage dev --region us-east-2
npx serverless deploy --stage prod --region us-east-2
```

## Webhooks

- Beta: `https://g87iwuddyc.execute-api.us-east-2.amazonaws.com/dev/webhooks/razorpay`
- Prod: `https://3b0q8s76wk.execute-api.us-east-2.amazonaws.com/prod/webhooks/razorpay`
