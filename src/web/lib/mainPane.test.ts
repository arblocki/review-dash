import { describe, expect, it } from 'vitest';
import { mainPaneState } from './mainPane';

const base = { loading: false, error: null, analysis: undefined, group: undefined };
const analysis = { groups: [] };

describe('mainPaneState', () => {
  it('is a skeleton while the first analysis runs', () => {
    expect(mainPaneState({ ...base, loading: true })).toBe('skeleton');
  });

  it('is an error once the request failed and nothing is running', () => {
    expect(mainPaneState({ ...base, error: new Error('x') })).toBe('error');
    expect(mainPaneState({ ...base, error: new Error('x'), loading: true })).toBe('skeleton');
  });

  it('is a group when an analysis and a selected group exist, even after a failed re-run', () => {
    expect(mainPaneState({ ...base, analysis, group: {} })).toBe('group');
    expect(mainPaneState({ ...base, analysis, group: {}, error: 'x' })).toBe('group');
  });

  it('is empty for a successful analysis with zero groups, never the skeleton', () => {
    expect(mainPaneState({ ...base, analysis })).toBe('empty');
    expect(mainPaneState({ ...base, analysis, loading: true })).toBe('empty');
  });

  it('is stale whenever the analysis is for an older version', () => {
    expect(mainPaneState({ ...base, analysis, group: {}, stale: true })).toBe('stale');
  });
});
