import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import { describeReviewedError } from './reviewedError';

describe('describeReviewedError', () => {
  it('turns head_moved into a refresh prompt with the short new head', () => {
    const err = new ApiError(409, 'stale', { code: 'head_moved', currentHeadSha: 'abc1234def' });
    expect(describeReviewedError(err)).toEqual({
      message: 'The PR changed (new head abc1234). Refresh to review the new version.',
      needsRefresh: true,
    });
  });
  it('shows unknown-id and other errors as-is, without a refresh prompt', () => {
    const bad = new ApiError(400, 'unknown hunk ids', { unknown: ['x'] });
    expect(describeReviewedError(bad)).toEqual({
      message: 'Could not save reviewed state: unknown hunk ids',
      needsRefresh: false,
    });
    expect(describeReviewedError(new Error('boom')).needsRefresh).toBe(false);
  });
  it('does not treat a 409 without the head_moved code as a stale head', () => {
    expect(describeReviewedError(new ApiError(409, 'x')).needsRefresh).toBe(false);
  });
});
