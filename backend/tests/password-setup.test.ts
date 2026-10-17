import { describe, expect, it } from 'vitest';
import { execute } from '../src/db/query';
import { createSetupToken } from '../src/services/passwordSetup';
import { api, makeUser } from './helpers';

describe('one-time password links', () => {
  it('sets the password once, signs out old sessions, and refuses reuse, expiry and short passwords', async () => {
    const account = await makeUser('hr_manager');
    const token = await createSetupToken(account.user.id);
    await api().post('/api/auth/set-password').send({ token, password: 'short' }).expect(400);
    const done = await api().post('/api/auth/set-password').send({ token, password: 'Baghdad-Spring-2026' }).expect(200);
    expect(done.body.email).toBe(account.user.email);
    await api().get('/api/auth/me').set(account.auth).expect(401);
    await api().post('/api/auth/login').send({ email: account.user.email, password: 'Baghdad-Spring-2026' }).expect(200);
    await api().post('/api/auth/set-password').send({ token, password: 'Another-Pass-2026' }).expect(400);

    const late = await createSetupToken(account.user.id);
    await execute("UPDATE password_setup_tokens SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL");
    await api().post('/api/auth/set-password').send({ token: late, password: 'Another-Pass-2026' }).expect(400);

    // A new link cancels the previous unused one.
    const first = await createSetupToken(account.user.id);
    await createSetupToken(account.user.id);
    await api().post('/api/auth/set-password').send({ token: first, password: 'Another-Pass-2026' }).expect(400);
  });
});
