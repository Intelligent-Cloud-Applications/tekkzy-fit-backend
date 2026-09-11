const {
  CognitoIdentityProviderClient,
  AdminInitiateAuthCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
} = require('@aws-sdk/client-cognito-identity-provider');
const { json, parseBody, requireGymKey, method } = require('./http');

const cognito = new CognitoIdentityProviderClient({
  region: process.env.COGNITO_REGION || process.env.AWS_REGION,
});

function poolId() {
  return String(process.env.COGNITO_USER_POOL_ID || '').trim();
}

function clientId() {
  return String(process.env.COGNITO_CLIENT_ID || '').trim();
}

function decodeJwt(token) {
  const payload = String(token || '').split('.')[1];
  if (!payload) return {};
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

function initials(name, email) {
  const source = String(name || email || 'TF').trim();
  const parts = source.split(/[\s@.]+/).filter(Boolean);
  const letters = (parts[0]?.[0] || 'T') + (parts[1]?.[0] || parts[0]?.[1] || 'F');
  return letters.toUpperCase().slice(0, 2);
}

function roleFromClaims(payload) {
  const groups = (payload['cognito:groups'] || []).map((g) => String(g).toLowerCase());
  if (groups.includes('admin')) return 'SUPER_ADMIN';
  if (groups.includes('manager')) return 'MANAGER';
  const custom = String(payload['custom:role'] || payload.role || '').toLowerCase();
  if (custom === 'admin' || custom === 'super_admin') return 'SUPER_ADMIN';
  return 'MANAGER';
}

function friendlyAuthError(err) {
  const name = err?.name || err?.__type || '';
  if (name === 'NotAuthorizedException' || name === 'UserNotFoundException') {
    return 'Invalid email or password.';
  }
  if (name === 'UserNotConfirmedException') return 'This account is not confirmed yet.';
  if (name === 'PasswordResetRequiredException') return 'Reset this password before signing in.';
  if (name === 'LimitExceededException' || name === 'TooManyRequestsException') {
    return 'Too many attempts. Try again in a few minutes.';
  }
  if (name === 'CodeMismatchException') return 'That reset code is incorrect.';
  if (name === 'ExpiredCodeException') return 'That reset code has expired. Request a new one.';
  if (name === 'InvalidPasswordException') {
    return 'Password must be at least 8 characters and include a letter, a number, and a symbol.';
  }
  if (name === 'InvalidParameterException') return err.message || 'Check the details and try again.';
  return err instanceof Error ? err.message : 'Request failed.';
}

function sessionFromToken(idToken, email) {
  const payload = decodeJwt(idToken);
  const name = payload.name || String(email || payload.email || '').split('@')[0] || 'Staff';
  return {
    token: idToken,
    user: {
      id: payload.sub || email,
      name,
      email: payload.email || email,
      role: roleFromClaims(payload),
      gymId: 'gym-1',
      avatarInitials: initials(name, payload.email || email),
    },
  };
}

async function login(email, password) {
  const out = await cognito.send(new AdminInitiateAuthCommand({
    UserPoolId: poolId(),
    ClientId: clientId(),
    AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
    AuthParameters: {
      USERNAME: email,
      PASSWORD: password,
    },
  }));
  if (out.ChallengeName) {
    throw Object.assign(new Error('This account needs an extra sign-in step. Contact the admin.'), {
      name: 'NotAuthorizedException',
    });
  }
  const idToken = out.AuthenticationResult?.IdToken;
  if (!idToken) throw new Error('Sign-in did not return a session.');
  return sessionFromToken(idToken, email);
}

async function forgot(email) {
  await cognito.send(new ForgotPasswordCommand({
    ClientId: clientId(),
    Username: email,
  }));
}

async function confirmForgot(email, code, password) {
  await cognito.send(new ConfirmForgotPasswordCommand({
    ClientId: clientId(),
    Username: email,
    ConfirmationCode: code,
    Password: password,
  }));
}

exports.handler = async (event) => {
  if (method(event) === 'OPTIONS') return json(200, { ok: true });
  if (!requireGymKey(event)) return json(401, { error: 'Unauthorized' });
  if (!poolId() || !clientId()) return json(500, { error: 'Sign-in is not configured.' });

  try {
    const verb = method(event);
    if (verb !== 'POST') return json(405, { error: 'Method not allowed' });

    const body = parseBody(event);
    const email = String(body.email || '').trim().toLowerCase();
    const resource = String(event.resource || event.path || '');

    if (resource.endsWith('/auth/forgot') || resource.endsWith('/forgot')) {
      if (!email) return json(400, { error: 'Email is required.' });
      try {
        await forgot(email);
      } catch (err) {
        const name = err?.name || '';
        if (name !== 'UserNotFoundException' && name !== 'InvalidParameterException') {
          throw err;
        }
      }
      return json(200, { ok: true, message: 'If that email is registered, a reset code is on its way.' });
    }

    if (resource.endsWith('/auth/confirm-forgot') || resource.endsWith('/confirm-forgot')) {
      const code = String(body.code || '').trim();
      const password = String(body.password || body.newPassword || '');
      if (!email || !code || !password) {
        return json(400, { error: 'Email, code, and new password are required.' });
      }
      await confirmForgot(email, code, password);
      return json(200, { ok: true, message: 'Password updated. You can sign in now.' });
    }

    const password = String(body.password || '');
    if (!email || !password) return json(400, { error: 'Email and password are required.' });
    return json(200, await login(email, password));
  } catch (err) {
    console.error('auth', err);
    const name = err?.name || '';
    const status = name === 'NotAuthorizedException' || name === 'UserNotFoundException' ? 401 : 400;
    return json(status, { error: friendlyAuthError(err) });
  }
};
