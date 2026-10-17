import { readFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';

/**
 * In production nginx serves the pages with its own Content-Security-Policy (frontend/nginx.conf);
 * the screen check runs the pages from this server. Both must send the same policy, or a page that
 * breaks the production policy (for example a font inlined as data:) passes the check and fails live.
 */
describe('security headers', () => {
  it('sends the pages the same Content-Security-Policy as nginx in production', async () => {
    const nginx = readFileSync(path.join(__dirname, '..', '..', 'frontend', 'nginx.conf'), 'utf8');
    const production = /add_header Content-Security-Policy "([^"]+)"/.exec(nginx)?.[1];
    expect(production).toBeTruthy();
    // A page path (not /api), answered whether or not the app has been built.
    const response = await request(createApp()).get('/employees');
    const directives = (policy: string) => policy.split(';').map((part) => part.trim().replace(/\s+/g, ' ')).filter(Boolean).sort();
    expect(directives(String(response.headers['content-security-policy']))).toEqual(directives(production!));
  });
});
