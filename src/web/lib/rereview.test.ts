import { describe, expect, it } from 'vitest';
import type { InterdiffResponse } from '../types';
import {
  effectiveHideReviewed,
  interdiffTruncationNotes,
  reReviewInfo,
  reReviewText,
} from './rereview';

const base: InterdiffResponse = {
  lastReviewedHeadSha: 'aaa',
  currentHeadSha: 'bbb',
  newCommits: [{ sha: '1', message: 'm' }],
  changedFiles: ['a.ts'],
  newHunkIds: [],
  compareAvailable: true,
  totalCommits: 1,
  commitsTruncated: false,
  filesTruncated: false,
};

describe('reReviewInfo', () => {
  it('is null without interdiff, without a previous review, or when the head is unchanged', () => {
    expect(reReviewInfo(null)).toBeNull();
    expect(reReviewInfo({ ...base, lastReviewedHeadSha: null })).toBeNull();
    expect(reReviewInfo({ ...base, currentHeadSha: 'aaa' })).toBeNull();
  });
  it('counts commits', () => {
    expect(reReviewInfo(base)).toEqual({ kind: 'commits', count: 1 });
  });
  it('reports a rewrite when compare is unavailable', () => {
    expect(reReviewInfo({ ...base, compareAvailable: false })).toEqual({ kind: 'rewritten' });
  });
});

describe('reReviewText', () => {
  it('pluralizes and explains rewrites', () => {
    expect(reReviewText({ kind: 'commits', count: 1 })).toBe(
      '1 new commit since you last reviewed',
    );
    expect(reReviewText({ kind: 'commits', count: 2 })).toBe(
      '2 new commits since you last reviewed',
    );
    expect(reReviewText({ kind: 'rewritten' })).toMatch(/history was rewritten/i);
  });
});

describe('effectiveHideReviewed', () => {
  it('defaults to the banner and respects an explicit choice', () => {
    expect(effectiveHideReviewed(null, { kind: 'commits', count: 2 })).toBe(true);
    expect(effectiveHideReviewed(null, null)).toBe(false);
    expect(effectiveHideReviewed(false, { kind: 'rewritten' })).toBe(false);
    expect(effectiveHideReviewed(true, null)).toBe(true);
  });
});

describe('interdiffTruncationNotes', () => {
  it('is empty when nothing was truncated', () => {
    expect(interdiffTruncationNotes(base)).toEqual([]);
  });
  it('reports truncated commits and files', () => {
    expect(
      interdiffTruncationNotes({ ...base, totalCommits: 2500, commitsTruncated: true }),
    ).toEqual(['showing 1 of 2500 commits']);
    expect(interdiffTruncationNotes({ ...base, filesTruncated: true })).toEqual([
      'GitHub lists at most 300 changed files — the list may be incomplete',
    ]);
  });
});
