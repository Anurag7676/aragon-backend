import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { EmailOtp, RefreshToken, User } from '../../src/db/models/index.js';
import { sendOtpEmail } from '../../src/integrations/mailer.js';
import { sha256Hex } from '../../src/lib/crypto.js';
import { createVerifiedUser, uniqueEmail } from '../helpers/factories.js';
import { lastOtp, refreshCookie, refreshCookieHeader, tokenFromCookie, TRUSTED_ORIGIN } from '../helpers/http.js';

const app = createApp();
const api = () => request(app);

const PASSWORD = 'correct-horse-battery';

async function signup(email: string, password = PASSWORD) {
  return api().post('/api/v1/auth/signup').send({ email, password });
}

/** Signs up and verifies, returning the session response. */
async function signupAndVerify(email = uniqueEmail(), password = PASSWORD) {
  await signup(email, password);
  const res = await api().post('/api/v1/auth/verify-email').send({ email, code: lastOtp(email, 'verify_email') });
  expect(res.status).toBe(200);
  return { email, res, cookie: refreshCookie(res), accessToken: res.body.accessToken as string };
}

/** Moves the latest code's creation time back so the resend cooldown no longer applies. */
async function expireCooldown(email: string) {
  const user = await User.findOne({ where: { email } });
  await EmailOtp.update({ createdAt: new Date(Date.now() - 5 * 60_000) }, { where: { userId: user!.id }, silent: true });
}

describe('signup and email verification', () => {
  it('creates an unverified account and emails a 6-digit code', async () => {
    const email = uniqueEmail();
    const res = await signup(email);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ email, resendAfterSeconds: 60 });
    expect(lastOtp(email, 'verify_email')).toMatch(/^\d{6}$/);

    const user = await User.findOne({ where: { email } });
    expect(user?.emailVerifiedAt).toBeNull();
    const otp = await EmailOtp.findOne({ where: { userId: user!.id } });
    expect(otp?.codeHash).not.toContain(lastOtp(email, 'verify_email'));
  });

  it('normalises the email and validates input', async () => {
    const email = uniqueEmail();
    const res = await signup(`  ${email.toUpperCase()} `);
    expect(res.status).toBe(201);
    expect(res.body.email).toBe(email);

    const invalid = await api().post('/api/v1/auth/signup').send({ email: 'nope', password: 'short' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
    expect(invalid.body.error.details.fields).toHaveProperty('email');
    expect(invalid.body.error.details.fields).toHaveProperty('password');
  });

  it('rejects a wrong code and reports attempts remaining', async () => {
    const email = uniqueEmail();
    await signup(email);
    const code = lastOtp(email, 'verify_email');
    const wrong = code === '000000' ? '111111' : '000000';

    const res = await api().post('/api/v1/auth/verify-email').send({ email, code: wrong });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'INVALID_CODE', details: { attemptsRemaining: 4 } });
  });

  it('locks the code after 5 wrong attempts, even for the right code', async () => {
    const email = uniqueEmail();
    await signup(email);
    const code = lastOtp(email, 'verify_email');
    const wrong = code === '000000' ? '111111' : '000000';

    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await api().post('/api/v1/auth/verify-email').send({ email, code: wrong })).status);
    }
    expect(statuses).toEqual([400, 400, 400, 400, 429]);

    const res = await api().post('/api/v1/auth/verify-email').send({ email, code });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('rejects an expired code', async () => {
    const email = uniqueEmail();
    await signup(email);
    const user = await User.findOne({ where: { email } });
    await EmailOtp.update({ expiresAt: new Date(Date.now() - 1000) }, { where: { userId: user!.id } });

    const res = await api().post('/api/v1/auth/verify-email').send({ email, code: lastOtp(email, 'verify_email') });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CODE_EXPIRED');
  });

  it('verifies with the right code and starts a session', async () => {
    const { email, res } = await signupAndVerify();

    expect(res.body).toMatchObject({ user: { email, emailVerified: true }, expiresIn: 900 });
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body).not.toHaveProperty('refreshToken');

    const cookie = refreshCookieHeader(res)!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('does not accept a code twice', async () => {
    const email = uniqueEmail();
    await signup(email);
    const code = lastOtp(email, 'verify_email');
    await api().post('/api/v1/auth/verify-email').send({ email, code }).expect(200);

    const again = await api().post('/api/v1/auth/verify-email').send({ email, code });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_VERIFIED');
  });

  it('refuses to sign up an email that is already verified', async () => {
    const { email } = await signupAndVerify();
    const res = await signup(email, 'another-password');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('lets a new signup replace the password of an unverified account', async () => {
    const email = uniqueEmail();
    await signup(email, 'squatter-password');
    const code = lastOtp(email, 'verify_email');
    expect((await signup(email, 'real-owner-password')).status).toBe(201);

    await api().post('/api/v1/auth/verify-email').send({ email, code }).expect(200);
    await api().post('/api/v1/auth/login').send({ email, password: 'squatter-password' }).expect(401);
    await api().post('/api/v1/auth/login').send({ email, password: 'real-owner-password' }).expect(200);
  });

  it('respects the resend cooldown, then sends a fresh code that replaces the old one', async () => {
    const email = uniqueEmail();
    await signup(email);
    const firstCode = lastOtp(email, 'verify_email');

    const tooSoon = await api().post('/api/v1/auth/resend-otp').send({ email, purpose: 'verify_email' });
    expect(tooSoon.status).toBe(202);
    expect(vi.mocked(sendOtpEmail)).toHaveBeenCalledTimes(1);

    await expireCooldown(email);
    await api().post('/api/v1/auth/resend-otp').send({ email, purpose: 'verify_email' }).expect(202);
    expect(vi.mocked(sendOtpEmail)).toHaveBeenCalledTimes(2);
    const secondCode = lastOtp(email, 'verify_email');

    if (firstCode !== secondCode) {
      await api().post('/api/v1/auth/verify-email').send({ email, code: firstCode }).expect(400);
    }
    await api().post('/api/v1/auth/verify-email').send({ email, code: secondCode }).expect(200);
  });

  it('answers resend requests for unknown emails exactly like known ones', async () => {
    const email = uniqueEmail('ghost');
    const res = await api().post('/api/v1/auth/resend-otp').send({ email, purpose: 'verify_email' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ email, resendAfterSeconds: 60 });
    expect(vi.mocked(sendOtpEmail)).not.toHaveBeenCalled();
  });
});

describe('login', () => {
  it('logs in a verified user', async () => {
    const { user, password } = await createVerifiedUser();
    const res = await api().post('/api/v1/auth/login').send({ email: user.email, password });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: user.id, email: user.email, emailVerified: true });
    expect(refreshCookieHeader(res)).toBeDefined();
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const { user } = await createVerifiedUser();
    const wrongPassword = await api().post('/api/v1/auth/login').send({ email: user.email, password: 'wrong-password' });
    const unknown = await api().post('/api/v1/auth/login').send({ email: uniqueEmail('ghost'), password: 'whatever-123' });

    for (const res of [wrongPassword, unknown]) {
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({ code: 'INVALID_CREDENTIALS', message: 'Incorrect email or password.' });
    }
  });

  it('sends unverified users to verification with a new code', async () => {
    const email = uniqueEmail();
    await signup(email);
    await expireCooldown(email);

    const res = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'EMAIL_NOT_VERIFIED', details: { email } });
    expect(refreshCookieHeader(res)).toBeUndefined();
    expect(lastOtp(email, 'verify_email')).toMatch(/^\d{6}$/);
  });
});

describe('sessions', () => {
  it('rotates the refresh token on every refresh', async () => {
    const { cookie } = await signupAndVerify();

    const res = await api().post('/api/v1/auth/refresh').set('Origin', TRUSTED_ORIGIN).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    const rotated = refreshCookie(res);
    expect(rotated).not.toBe(cookie);

    await api().post('/api/v1/auth/refresh').set('Cookie', rotated).expect(200);
  });

  it('tolerates a concurrent refresh within the grace window without ending the session', async () => {
    const { cookie } = await signupAndVerify();
    const first = await api().post('/api/v1/auth/refresh').set('Cookie', cookie).expect(200);

    // A second tab presents the same, just-rotated token.
    await api().post('/api/v1/auth/refresh').set('Cookie', cookie).expect(401);
    await api().post('/api/v1/auth/refresh').set('Cookie', refreshCookie(first)).expect(200);
  });

  it('treats reuse of an old refresh token as theft and revokes the whole session', async () => {
    const { cookie } = await signupAndVerify();
    const first = await api().post('/api/v1/auth/refresh').set('Cookie', cookie).expect(200);
    const current = refreshCookie(first);

    // Pretend the old token was rotated well outside the grace window.
    await RefreshToken.update(
      { revokedAt: new Date(Date.now() - 60_000) },
      { where: { tokenHash: sha256Hex(tokenFromCookie(cookie)) } },
    );

    const reuse = await api().post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('SESSION_ENDED');

    // The attacker's reuse also kills the legitimate, newer token.
    await api().post('/api/v1/auth/refresh').set('Cookie', current).expect(401);
  });

  it('rejects refresh without a cookie or with an unknown token', async () => {
    const none = await api().post('/api/v1/auth/refresh');
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe('NO_SESSION');

    await api().post('/api/v1/auth/refresh').set('Cookie', 'aragon_rt=not-a-real-token').expect(401);
  });

  it('blocks cookie-authenticated routes from untrusted origins', async () => {
    const { cookie } = await signupAndVerify();
    for (const path of ['/api/v1/auth/refresh', '/api/v1/auth/logout']) {
      const res = await api().post(path).set('Origin', 'https://evil.example').set('Cookie', cookie);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('UNTRUSTED_ORIGIN');
    }
    // The token is still valid afterwards.
    await api().post('/api/v1/auth/refresh').set('Cookie', cookie).expect(200);
  });

  it('logs out: clears the cookie and revokes the session', async () => {
    const { cookie } = await signupAndVerify();

    const res = await api().post('/api/v1/auth/logout').set('Origin', TRUSTED_ORIGIN).set('Cookie', cookie);
    expect(res.status).toBe(204);
    expect(refreshCookieHeader(res)).toMatch(/Expires=Thu, 01 Jan 1970/);

    await api().post('/api/v1/auth/refresh').set('Cookie', cookie).expect(401);
  });

  it('requires a valid bearer token for /me', async () => {
    const { accessToken, email } = await signupAndVerify();

    await api().get('/api/v1/auth/me').expect(401);
    const bad = await api().get('/api/v1/auth/me').set('Authorization', 'Bearer not.a.jwt');
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('TOKEN_INVALID');

    const res = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
  });
});

describe('password reset', () => {
  it('answers the same way for unknown emails and sends nothing', async () => {
    const { user } = await createVerifiedUser();
    const ghost = uniqueEmail('ghost');

    const known = await api().post('/api/v1/auth/forgot-password').send({ email: user.email });
    const unknown = await api().post('/api/v1/auth/forgot-password').send({ email: ghost });

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(Object.keys(unknown.body)).toEqual(Object.keys(known.body));
    expect(vi.mocked(sendOtpEmail)).toHaveBeenCalledTimes(1);
    expect(lastOtp(user.email, 'reset_password')).toMatch(/^\d{6}$/);
  });

  it('resets the password, signs out every session and allows login with the new password', async () => {
    const { email, cookie } = await signupAndVerify();
    await api().post('/api/v1/auth/forgot-password').send({ email }).expect(202);

    const res = await api()
      .post('/api/v1/auth/reset-password')
      .send({ email, code: lastOtp(email, 'reset_password'), password: 'brand-new-password' });
    expect(res.status).toBe(204);

    await api().post('/api/v1/auth/refresh').set('Cookie', cookie).expect(401);
    await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(401);
    await api().post('/api/v1/auth/login').send({ email, password: 'brand-new-password' }).expect(200);
  });

  it('does not accept an email-verification code as a reset code', async () => {
    const email = uniqueEmail();
    await signup(email);
    const verifyCode = lastOtp(email, 'verify_email');

    const res = await api()
      .post('/api/v1/auth/reset-password')
      .send({ email, code: verifyCode, password: 'brand-new-password' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CODE');
  });

  it('verifies the email of an account that resets its password', async () => {
    const email = uniqueEmail();
    await signup(email);
    await api().post('/api/v1/auth/forgot-password').send({ email }).expect(202);
    await api()
      .post('/api/v1/auth/reset-password')
      .send({ email, code: lastOtp(email, 'reset_password'), password: 'brand-new-password' })
      .expect(204);

    await api().post('/api/v1/auth/login').send({ email, password: 'brand-new-password' }).expect(200);
  });
});
