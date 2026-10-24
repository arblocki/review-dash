import { memo, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import {
  Decoration,
  Diff,
  Hunk as DiffHunk,
  type ChangeData,
  type DiffType,
} from 'react-diff-view';
import {
  applyExpansions,
  changeKey,
  findChangeKey,
  findHunk,
  gapAfter,
  gapBefore,
  gapSize,
  expansionRange,
  hideWhitespaceOnly,
  isInlineRange,
  keysBetween,
  selectRange,
  toRdvHunks,
  type ExpandDirection,
  type Gap,
} from '../lib/diffModel';
import { highlightHunks, languageForPath } from '../lib/highlight';
import { placeThreads } from '../lib/threadPlacement';
import { useFocusedHunk, useReviewState } from '../reviewState';
import { useFileDraftAnchors, useReview } from '../state';
import type { Hunk, ParsedFile, ReviewThread } from '../types';
import { DraftComposer } from './DraftComposer';
import { ThreadWidget } from './ThreadWidget';

export const fileAnchorId = (path: string): string => `file-${path}`;

const EXPAND_STEP = 20;

const STATUS_BADGE: Record<string, string> = {
  added: 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300',
  removed: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300',
  renamed: 'bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300',
};

function diffTypeFor(status: ParsedFile['status']): DiffType {
  switch (status) {
    case 'added':
      return 'add';
    case 'removed':
      return 'delete';
    case 'renamed':
      return 'rename';
    case 'copied':
      return 'copy';
    default:
      return 'modify';
  }
}

/**
 * One file's header plus the given hunks (all of the file's hunks by default). Rendering a
 * subset is how a group card shows only the hunks that belong to it.
 */
export function FileDiff({
  file,
  hunks = file.hunks,
  anchorId,
  showFileThreads = true,
}: {
  file: ParsedFile;
  hunks?: Hunk[];
  anchorId?: string;
  /** Render the file-level Discussion; false where another group card owns it. */
  showFileThreads?: boolean;
}) {
  const { pr, hideWhitespace, threads } = useReview();
  const [collapsed, setCollapsed] = useState(false);
  const shown = useMemo(
    () => (hideWhitespace ? hideWhitespaceOnly(hunks) : hunks),
    [hunks, hideWhitespace],
  );
  const hidden = useMemo(() => file.hunks.filter((h) => !hunks.includes(h)), [file.hunks, hunks]);
  const placement = useMemo(
    () =>
      placeThreads(
        threads.filter((t) => t.path === file.path),
        shown,
        hidden,
      ),
    [threads, file.path, shown, hidden],
  );
  const githubLink = `${pr.url}/files`;
  const changed = hunks.reduce((n, h) => n + h.lines.length, 0);

  let body: ReactNode;
  if (file.binary) {
    body = <Placeholder link={githubLink}>Binary file not shown.</Placeholder>;
  } else if (file.patchMissing) {
    body = (
      <Placeholder link={githubLink}>
        GitHub did not return a diff for this file (too large).
      </Placeholder>
    );
  } else if (hunks.length === 0) {
    body =
      (file.status === 'renamed' || file.status === 'copied') &&
      file.oldPath &&
      file.oldPath !== file.path ? (
        <Placeholder>
          {file.status === 'renamed' ? 'Renamed' : 'Copied'} from{' '}
          <code className="font-mono">{file.oldPath}</code> — no content changes.
        </Placeholder>
      ) : (
        <Placeholder>No content changes (rename or mode change only).</Placeholder>
      );
  } else if (shown.length === 0) {
    body = <Placeholder>Only whitespace changes (hidden).</Placeholder>;
  } else {
    body = (
      <LazyMount estimate={changed * 20 + 40}>
        <FileDiffBody file={file} hunks={shown} hidden={hidden} threads={placement.inline} />
      </LazyMount>
    );
  }

  return (
    <section
      id={anchorId}
      className="scroll-mt-[calc(var(--header-h)+8px)] overflow-hidden rounded-md border border-gray-200 dark:border-gray-800"
      data-testid="file-diff"
      data-path={file.path}
      data-hunk-ids={hunks.map((h) => h.id).join(' ')}
    >
      <div className="flex items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 py-1.5 text-sm dark:border-gray-800 dark:bg-gray-900">
        <button
          type="button"
          className="w-4 text-gray-500"
          aria-label={collapsed ? 'Expand file' : 'Collapse file'}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="min-w-0 flex-1 truncate font-mono font-medium" title={file.path}>
          {file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ` : ''}
          {file.path}
        </span>
        {file.status !== 'modified' && (
          <span
            className={`rounded px-1.5 text-xs ${
              STATUS_BADGE[file.status] ?? 'bg-gray-200 text-gray-700 dark:bg-gray-800'
            }`}
          >
            {file.status}
          </span>
        )}
        {hunks.length > 0 && <HunkCheckbox ids={hunks.map((h) => h.id)} label="File reviewed" />}
        <span className="shrink-0 font-mono text-xs">
          <span className="text-green-700 dark:text-green-400">+{file.additions}</span>{' '}
          <span className="text-red-700 dark:text-red-400">−{file.deletions}</span>
        </span>
      </div>
      {!collapsed && showFileThreads && placement.fileLevel.length > 0 && (
        <div
          className="border-b border-gray-200 bg-gray-50/50 py-1 dark:border-gray-800 dark:bg-gray-900/40"
          data-testid="file-discussion"
        >
          <p className="px-3 text-xs font-semibold text-gray-500 dark:text-gray-400">Discussion</p>
          {placement.fileLevel.map((t) => (
            <ThreadWidget key={t.id} thread={t} showLocation />
          ))}
        </div>
      )}
      {!collapsed && body}
    </section>
  );
}

function Placeholder({ children, link }: { children: ReactNode; link?: string }) {
  return (
    <div className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
      {children}{' '}
      {link && (
        <a
          href={link}
          target="_blank"
          rel="noreferrer"
          className="text-blue-600 hover:underline dark:text-blue-400"
        >
          View on GitHub ↗
        </a>
      )}
    </div>
  );
}

/** Mounts children once the placeholder nears the viewport, so huge PRs stay responsive. */
function LazyMount({ estimate, children }: { estimate: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (visible || !el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { rootMargin: '1500px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);
  return (
    <div ref={ref} style={visible ? undefined : { minHeight: estimate }}>
      {visible && children}
    </div>
  );
}

interface Selection {
  anchor: string;
  focus: string;
}

const FileDiffBody = memo(function FileDiffBody({
  file,
  hunks,
  hidden,
  threads: fileThreads,
}: {
  file: ParsedFile;
  hunks: Hunk[];
  /** Original hunks of this file that are not being displayed. */
  hidden: Hunk[];
  /** Threads on lines of `hunks`; the rest are shown by FileDiff. */
  threads: ReviewThread[];
}) {
  const { pr, viewType, fetchFile, startDraft } = useReview();
  const anchors = useFileDraftAnchors(file.path);
  const language = useMemo(() => languageForPath(file.path), [file.path]);

  // --- context expansion: replay old-line ranges onto the hunks once the old file is loaded
  const base = useMemo(() => toRdvHunks(hunks), [hunks]);
  const [expansions, setExpansions] = useState<[number, number][]>([]);
  const [source, setSource] = useState<string[]>();
  const [expandError, setExpandError] = useState<string>();
  useEffect(() => setExpansions((e) => (e.length ? [] : e)), [base]);
  const rdvHunks = useMemo(
    () => applyExpansions(base, source, expansions),
    [base, source, expansions],
  );
  // Context lines are identical on both sides, so the old file (base commit) serves both.
  const canExpand = file.status !== 'added' && file.status !== 'removed';

  async function expand(gap: (hs: typeof rdvHunks, lines: string[]) => Gap, dir: ExpandDirection) {
    try {
      setExpandError(undefined);
      const lines = source ?? (await fetchFile(file.oldPath ?? file.path, pr.baseSha));
      setSource(lines);
      const range = expansionRange(
        gap(applyExpansions(base, lines, expansions), lines),
        dir,
        EXPAND_STEP,
        hidden,
      );
      if (range) setExpansions((e) => [...e, range]);
    } catch (err) {
      setExpandError((err as Error).message);
    }
  }

  // --- threads and drafts as widgets
  const { widgets, unplaced } = useMemo(() => {
    const byKey = new Map<string, ReactNode[]>();
    const unplaced: ReactNode[] = [];
    const put = (
      pos: { side: 'LEFT' | 'RIGHT'; line: number } | null,
      id: string,
      node: (loose: boolean) => ReactNode,
    ) => {
      const key = pos && findChangeKey(rdvHunks, pos);
      if (key) {
        byKey.set(key, [...(byKey.get(key) ?? []), <div key={id}>{node(false)}</div>]);
      } else if (!pos || !findHunk(hidden, pos)) {
        unplaced.push(<div key={id}>{node(true)}</div>);
      }
    };
    for (const t of fileThreads) {
      put(t.line === null ? null : { side: t.diffSide, line: t.line }, t.id, (loose) => (
        <ThreadWidget thread={t} showLocation={loose} />
      ));
    }
    for (const a of anchors) {
      const range = { line: a.line, side: a.side, startLine: a.startLine, startSide: a.startSide };
      put({ side: a.side, line: a.line }, a.id, () => (
        <DraftComposer draftId={a.id} inline={isInlineRange(file.hunks, range)} />
      ));
    }
    return {
      widgets: Object.fromEntries([...byKey].map(([k, nodes]) => [k, <>{nodes}</>])),
      unplaced,
    };
  }, [rdvHunks, fileThreads, anchors, file.hunks, hidden]);

  // --- gutter selection: click, shift-click, or drag across lines to open a composer
  const [sel, setSel] = useState<Selection | null>(null);
  const dragRef = useRef<Selection | null>(null);
  const lastAnchor = useRef<string | null>(null);
  const hunksRef = useRef(rdvHunks);
  hunksRef.current = rdvHunks;

  useEffect(() => {
    const up = () => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      setSel(null);
      const range = selectRange(hunksRef.current, d.anchor, d.focus);
      if (!range) return;
      startDraft({
        path: file.path,
        range,
        hunkId: findHunk(file.hunks, { side: range.side, line: range.line })?.id,
      });
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, [file.path, file.hunks, startDraft]);

  const gutterEvents = useMemo(
    () => ({
      onMouseDown: ({ change }: { change: ChangeData | null }, e: MouseEvent<HTMLElement>) => {
        if (!change || e.button !== 0) return;
        const key = changeKey(change);
        let next: Selection;
        if (e.shiftKey && lastAnchor.current) {
          next = { anchor: lastAnchor.current, focus: key };
          e.preventDefault();
        } else {
          lastAnchor.current = key;
          next = { anchor: key, focus: key };
        }
        dragRef.current = next;
        setSel(next);
      },
      onMouseEnter: ({ change }: { change: ChangeData | null }) => {
        const d = dragRef.current;
        if (!change || !d) return;
        const next = { ...d, focus: changeKey(change) };
        dragRef.current = next;
        setSel(next);
      },
    }),
    [],
  );

  const selectedChanges = useMemo(() => {
    const keys = new Set<string>();
    if (sel) keysBetween(rdvHunks, sel.anchor, sel.focus).forEach((k) => keys.add(k));
    for (const a of anchors) {
      if (a.startLine === undefined) continue;
      const from = findChangeKey(rdvHunks, { side: a.startSide ?? a.side, line: a.startLine });
      const to = findChangeKey(rdvHunks, { side: a.side, line: a.line });
      if (from && to) keysBetween(rdvHunks, from, to).forEach((k) => keys.add(k));
    }
    return [...keys];
  }, [sel, anchors, rdvHunks]);

  const tokens = useMemo(() => highlightHunks(rdvHunks, language), [rdvHunks, language]);

  const trailing = source ? gapAfter(rdvHunks, source.length) : undefined;

  // An expanded hunk can swallow its neighbour, so a bar covers every original hunk that
  // starts inside it.
  const idsIn = (r: (typeof rdvHunks)[number]) =>
    hunks
      .filter((h) =>
        r.newLines === 0
          ? h.newStart === r.newStart
          : h.newStart >= r.newStart && h.newStart < r.newStart + r.newLines,
      )
      .map((h) => h.id);

  const renderHunks = (hs: typeof rdvHunks) =>
    hs.flatMap((hunk, i) => {
      const gap = gapBefore(hs, i);
      const up = canExpand ? expansionRange(gap, 'up', EXPAND_STEP, hidden) : null;
      const all = canExpand ? expansionRange(gap, 'all', EXPAND_STEP, hidden) : null;
      const els = [
        <Decoration key={`bar-${i}-${hunk.content}`}>
          <ExpandBar
            hidden={gapSize(gap)}
            header={hunk.content}
            hunkIds={idsIn(hunk)}
            onUp={up ? () => void expand((h) => gapBefore(h, i), 'up') : undefined}
            onDown={
              i > 0 && canExpand && expansionRange(gap, 'down', EXPAND_STEP, hidden)
                ? () => void expand((h) => gapBefore(h, i), 'down')
                : undefined
            }
            onAll={all ? () => void expand((h) => gapBefore(h, i), 'all') : undefined}
          />
        </Decoration>,
        <DiffHunk key={`hunk-${hunk.oldStart}-${hunk.newStart}`} hunk={hunk} />,
      ];
      if (i === hs.length - 1 && canExpand && (!trailing || gapSize(trailing) > 0)) {
        const t = (h: typeof rdvHunks, lines: string[]) => gapAfter(h, lines.length);
        els.push(
          <Decoration key="bar-end">
            <ExpandBar
              hidden={trailing ? gapSize(trailing) : undefined}
              onDown={() => void expand(t, 'down')}
              onAll={trailing ? () => void expand(t, 'all') : undefined}
            />
          </Decoration>,
        );
      }
      return els;
    });

  return (
    <div className="rd-diff overflow-x-auto text-[12.5px]">
      {expandError && (
        <p className="bg-red-50 px-3 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
          Could not load file for context: {expandError}
        </p>
      )}
      {unplaced.length > 0 && (
        <div className="border-b border-gray-200 bg-gray-50/50 py-1 dark:border-gray-800 dark:bg-gray-900/40">
          <p className="px-3 text-xs text-gray-500 dark:text-gray-400">
            Comments on lines not shown in the diff below:
          </p>
          {unplaced}
        </div>
      )}
      <Diff
        diffType={diffTypeFor(file.status)}
        hunks={rdvHunks}
        viewType={viewType}
        widgets={widgets}
        tokens={tokens}
        selectedChanges={selectedChanges}
        gutterEvents={gutterEvents}
        renderGutter={renderGutter}
      >
        {renderHunks}
      </Diff>
    </div>
  );
});

function renderGutter({
  inHoverState,
  renderDefault,
}: {
  inHoverState: boolean;
  renderDefault: () => ReactNode;
}): ReactNode {
  return inHoverState ? (
    <span className="rd-add" title="Comment (shift-click or drag to select a range)">
      +
    </span>
  ) : (
    renderDefault()
  );
}

/** Reviewed checkbox for one or more hunks: checked once all are reviewed or auto-cleared. */
function HunkCheckbox({ ids, label = 'Reviewed' }: { ids: string[]; label?: string }) {
  const { status, setHunks } = useReviewState();
  const statuses = ids.map(status);
  const done = statuses.every((s) => s !== 'none');
  const auto = done && statuses.every((s) => s === 'auto');
  return (
    <label
      className={`flex shrink-0 cursor-pointer items-center gap-1 rounded px-1 font-sans text-xs ${
        auto ? 'text-sky-700 dark:text-sky-300' : 'text-gray-600 dark:text-gray-300'
      }`}
      title={
        auto ? 'Auto-cleared (not reviewed by you). Uncheck to review it yourself.' : undefined
      }
    >
      <input
        type="checkbox"
        checked={done}
        aria-label={label}
        data-testid="hunk-reviewed"
        data-state={auto ? 'auto' : done ? 'reviewed' : 'none'}
        className={auto ? 'accent-sky-500' : 'accent-green-600'}
        onChange={() => setHunks(ids, !done)}
      />
      {auto ? 'auto-cleared' : label.toLowerCase()}
    </label>
  );
}

function ExpandBar({
  hidden,
  header,
  hunkIds,
  onUp,
  onDown,
  onAll,
}: {
  hidden?: number;
  header?: string;
  /** Hunks this bar sits above; adds the reviewed checkbox and keyboard focus ring. */
  hunkIds?: string[];
  onUp?: () => void;
  onDown?: () => void;
  onAll?: () => void;
}) {
  const b =
    'rounded px-1.5 py-0.5 text-blue-700 hover:bg-blue-100 dark:text-blue-300 dark:hover:bg-blue-900/50';
  const { hunkId: focused } = useFocusedHunk();
  const isFocused = !!hunkIds && focused !== null && hunkIds.includes(focused);
  return (
    <div
      className={`flex scroll-mt-[calc(var(--header-h)+8px)] items-center gap-1 bg-blue-50/70 px-2 py-0.5 font-sans text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300 ${
        isFocused ? 'ring-2 ring-blue-500 ring-inset' : ''
      }`}
      data-hunk-id={hunkIds?.join(' ')}
      data-focused={isFocused ? 'true' : undefined}
    >
      {hunkIds && hunkIds.length > 0 && <HunkCheckbox ids={hunkIds} />}
      {onUp && (
        <button type="button" className={b} onClick={onUp}>
          ↑ Expand up
        </button>
      )}
      {onDown && (
        <button type="button" className={b} onClick={onDown}>
          ↓ Expand down
        </button>
      )}
      {onAll && (
        <button type="button" className={b} onClick={onAll}>
          Show all{hidden ? ` ${hidden} lines` : ''}
        </button>
      )}
      {hidden !== undefined && hidden > 0 && !onAll && <span>{hidden} lines hidden</span>}
      {header && <span className="ml-1 min-w-0 truncate font-mono">{header}</span>}
    </div>
  );
}
