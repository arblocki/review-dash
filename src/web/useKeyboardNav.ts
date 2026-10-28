import { useEffect, useRef } from 'react';
import { keyAction, stepId, stepIndex } from './lib/keyboard';
import { firstChangedRange } from './lib/reviewFilter';
import { useFocusedHunk, useReviewState } from './reviewState';
import { useReview } from './state';

export interface NavOptions {
  /** Hunks (and hunkless files, by file key) on screen in display order; hidden ones left out. */
  hunkIds: string[];
  /** Group keys in rail order; empty in By file view, where J/K do nothing. */
  groupKeys: string[];
  selectedKey: string | undefined;
  selectGroup(key: string): void;
  /** First hunk on screen once `key` is selected. */
  firstHunkOf(key: string): string | null;
  /** A modal other than help is open: shortcuts are off. */
  modalOpen: boolean;
  helpOpen: boolean;
  setHelpOpen(open: boolean): void;
}

/** Brings a hunk's header into view; retries while a lazily mounted file is still rendering. */
export function scrollToHunk(id: string, tries = 8): void {
  const has = (el: Element, attr: string) => (el.getAttribute(attr) ?? '').split(' ').includes(id);
  const bar = [...document.querySelectorAll('[data-hunk-id]')].find((el) =>
    has(el, 'data-hunk-id'),
  );
  if (bar) {
    bar.scrollIntoView({ block: 'start' });
    return;
  }
  const section = [...document.querySelectorAll('[data-hunk-ids]')].find((el) =>
    has(el, 'data-hunk-ids'),
  );
  section?.scrollIntoView({ block: 'start' });
  if (tries > 0) setTimeout(() => scrollToHunk(id, tries - 1), 80);
}

/** Global j/k/J/K/r/c/?/Esc shortcuts (PLAN section 6). */
export function useKeyboardNav(opts: NavOptions): void {
  const { files, startDraft } = useReview();
  const { toggleHunk, status, hideReviewed } = useReviewState();
  const { hunkId, setHunkId } = useFocusedHunk();
  // One listener, reading the latest values through a ref.
  const latest = useRef({
    opts,
    files,
    startDraft,
    toggleHunk,
    status,
    hideReviewed,
    hunkId,
    setHunkId,
  });
  latest.current = { opts, files, startDraft, toggleHunk, status, hideReviewed, hunkId, setHunkId };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = keyAction(e);
      if (!action) return;
      const c = latest.current;
      const { hunkIds, groupKeys, selectedKey } = c.opts;
      if (c.opts.modalOpen) return;
      if (action === 'help') {
        e.preventDefault();
        c.opts.setHelpOpen(!c.opts.helpOpen);
        return;
      }
      if (action === 'escape') {
        if (c.opts.helpOpen) c.opts.setHelpOpen(false);
        return;
      }
      if (c.opts.helpOpen) return;
      e.preventDefault();
      const focus = (id: string | null) => {
        c.setHunkId(id);
        if (id) scrollToHunk(id);
      };
      switch (action) {
        case 'nextHunk':
        case 'prevHunk':
          focus(stepId(hunkIds, c.hunkId, action === 'nextHunk' ? 1 : -1));
          break;
        case 'nextGroup':
        case 'prevGroup': {
          if (groupKeys.length === 0) break;
          const i = stepIndex(
            selectedKey ? groupKeys.indexOf(selectedKey) : 0,
            groupKeys.length,
            action === 'nextGroup' ? 1 : -1,
          );
          const key = groupKeys[i];
          if (key === undefined || key === selectedKey) break;
          c.opts.selectGroup(key);
          c.setHunkId(c.opts.firstHunkOf(key));
          break;
        }
        case 'toggleReviewed': {
          const id = c.hunkId;
          if (!id) break;
          // The hunk is about to disappear when reviewed ones are hidden: move on first.
          if (c.hideReviewed && c.status(id) === 'none') {
            const next = stepId(hunkIds, id, 1);
            const other = next !== id ? next : stepId(hunkIds, id, -1);
            focus(other !== id ? other : null);
          }
          c.toggleHunk(id);
          break;
        }
        case 'comment': {
          if (!c.hunkId || !hunkIds.includes(c.hunkId)) break;
          const hunk = c.files.flatMap((f) => f.hunks).find((h) => h.id === c.hunkId);
          const range = hunk && firstChangedRange(hunk);
          if (hunk && range) c.startDraft({ path: hunk.path, range, hunkId: hunk.id });
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
