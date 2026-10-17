import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '../src/app';

/** The release shown to users (frontend/src/lib/releases.ts) and the server's version must move together. */
describe('release version', () => {
  it('matches between the server, the app and both package files', () => {
    const releases = readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'lib', 'releases.ts'), 'utf8');
    const shown = /version:\s*'(\d+\.\d+(?:\.\d+)?)'/.exec(releases)?.[1];
    expect(shown).toBeTruthy();
    const full = (version: string) => [...version.split('.'), '0', '0'].slice(0, 3).join('.');
    expect(APP_VERSION).toBe(full(shown!));
    const frontendPackage = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'frontend', 'package.json'), 'utf8'));
    expect(frontendPackage.version).toBe(APP_VERSION);
  });
});
