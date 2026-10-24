import { describe, expect, it } from 'vitest';
import { configDir, dataDir, dbPath } from './paths.js';

describe('paths', () => {
  it('uses home-relative defaults', () => {
    expect(dataDir({}, '/home/me')).toBe('/home/me/.review-dash');
    expect(configDir({}, '/home/me')).toBe('/home/me/.config/review-dash');
    expect(dbPath({}, '/home/me')).toBe('/home/me/.review-dash/review-dash.db');
  });

  it('respects env overrides', () => {
    const env = { REVIEW_DASH_HOME: '/data', XDG_CONFIG_HOME: '/xdg' };
    expect(dataDir(env, '/home/me')).toBe('/data');
    expect(configDir(env, '/home/me')).toBe('/xdg/review-dash');
  });
});
