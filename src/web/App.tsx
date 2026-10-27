import { useCallback, useMemo, useState } from 'react';
import { AnalysisProvider, useAnalysis } from './analysis';
import { hideWhitespaceOnly } from './lib/diffModel';
import { sectionItemIds } from './lib/reviewFilter';
import { sectionsForGroup } from './lib/sections';
import { ReviewStateProvider, useReviewState, useVisibleSections } from './reviewState';
import { useKeyboardNav } from './useKeyboardNav';
import { HelpOverlay } from './components/HelpOverlay';
import { ReReviewBanner } from './components/ReReviewBanner';
import { fileAnchorId } from './components/FileDiff';
import { AnalysisBar } from './components/AnalysisBar';
import {
  AnalysisBanner,
  AnalysisEmpty,
  AnalysisError,
  AnalysisSkeleton,
  ProviderNotice,
} from './components/AnalysisStatus';
import { FileList } from './components/FileList';
import { GroupCard } from './components/GroupCard';
import { GroupPicker } from './components/GroupPicker';
import { GroupRail } from './components/GroupRail';
import { AllFilesDiff } from './components/HunkList';
import { Header } from './components/Header';
import { Layout } from './components/Layout';
import { SubmitModal } from './components/SubmitModal';
import { groupNeighbors, orderGroups, pickGroup, resolveView, type ViewMode } from './lib/groups';
import { mainPaneState } from './lib/mainPane';
import { fileThreadOwners } from './lib/sections';
import { ReviewProvider, useReview } from './state';

function Review() {
  const { files, threadsError, hideWhitespace, refreshing, refresh } = useReview();
  const {
    verifyChecked,
    toggleVerify,
    error: stateError,
    errorNeedsRefresh,
    dismissError,
  } = useReviewState();
  const { result, loading, error, stale } = useAnalysis();
  const [submitting, setSubmitting] = useState(false);
  const [choice, setChoice] = useState<ViewMode | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  const analysis = result?.analysis;
  // By group becomes the default as soon as an analysis exists; until then (or while the
  // analysis is for an older head) the M1 view shows.
  const view: ViewMode = resolveView(choice, !!analysis, stale);
  const groups = useMemo(
    () => (analysis ? orderGroups(analysis.groups, view) : []),
    [analysis, view],
  );
  const group = pickGroup(groups, selectedKey);
  // Each file's unanchored threads render in one group only: the first that contains the file.
  const fileThreadPaths = useMemo(() => {
    const owners = fileThreadOwners(groups, files);
    return new Set([...owners].filter(([, key]) => key === group?.key).map(([path]) => path));
  }, [groups, files, group?.key]);

  const select = useCallback((key: string) => {
    setSelectedKey(key);
    window.scrollTo({ top: 0 });
  }, []);

  // Hunks on screen in display order, for j/k: the selected group, or every file in By file.
  const navSections = useMemo(
    () =>
      view === 'file'
        ? files.map((file) => ({ file, hunks: file.hunks, anchorId: fileAnchorId(file.path) }))
        : group
          ? sectionsForGroup(files, group)
          : [],
    [view, files, group],
  );
  const visibleNav = useVisibleSections(navSections);
  const { hideReviewed, reviewed, fileKeys } = useReviewState();
  // Hunk ids plus the keys of hunkless files, so j/k also stop on those.
  const hunkIds = useMemo(
    () =>
      sectionItemIds(
        hideWhitespace
          ? visibleNav.map((s) =>
              s.hunks.length === 0 ? s : { ...s, hunks: hideWhitespaceOnly(s.hunks) },
            )
          : visibleNav,
        fileKeys,
      ),
    [visibleNav, hideWhitespace, fileKeys],
  );
  useKeyboardNav({
    hunkIds,
    groupKeys: view === 'file' ? [] : groups.map((g) => g.key),
    selectedKey: group?.key,
    selectGroup: select,
    firstHunkOf: (key) => {
      const g = groups.find((x) => x.key === key);
      if (!g) return null;
      const secs = sectionsForGroup(files, g).flatMap((s) => {
        if (s.hunks.length === 0) {
          const key = fileKeys.get(s.file.path);
          return key !== undefined && !(hideReviewed && reviewed.has(key)) ? [s] : [];
        }
        const hunks = s.hunks.filter((h) => !(hideReviewed && reviewed.has(h.id)));
        return hunks.length > 0 ? [{ ...s, hunks }] : [];
      });
      return sectionItemIds(secs, fileKeys)[0] ?? null;
    },
    modalOpen: submitting,
    helpOpen,
    setHelpOpen,
  });

  const pane = mainPaneState({ loading, error, analysis, group, stale });
  let main;
  if (view === 'file' || pane === 'stale') {
    main = (
      <>
        <AnalysisBanner />
        {error && !loading && <AnalysisError view={view} onView={setChoice} />}
        <AllFilesDiff />
      </>
    );
  } else if (pane === 'group' && group && analysis) {
    main = (
      <>
        {error && !loading && <AnalysisError view={view} onView={setChoice} />}
        <ProviderNotice />
        <GroupPicker groups={groups} selectedKey={group.key} onSelect={select} />
        <GroupCard
          key={group.key}
          group={group}
          allGroups={analysis.groups}
          neighbors={groupNeighbors(groups, group.key)}
          fileThreadPaths={fileThreadPaths}
          checked={verifyChecked}
          onToggleVerify={toggleVerify}
          onSelect={select}
        />
      </>
    );
  } else if (pane === 'empty' && analysis) {
    main = (
      <>
        {error && !loading && <AnalysisError view={view} onView={setChoice} />}
        <AnalysisEmpty summary={analysis.summary} onView={setChoice} />
      </>
    );
  } else if (pane === 'error') {
    main = <AnalysisError view={view} onView={setChoice} />;
  } else {
    main = <AnalysisSkeleton />;
  }

  return (
    <>
      <Layout
        header={
          <Header
            onSubmit={() => setSubmitting(true)}
            extra={<AnalysisBar view={view} onView={setChoice} onHelp={() => setHelpOpen(true)} />}
          />
        }
        rail={
          view === 'file' ? (
            <FileList files={files} />
          ) : (
            <GroupRail
              groups={groups}
              selectedKey={group?.key}
              onSelect={select}
              unrelated={analysis?.unrelatedOrSuspicious ?? []}
              loading={loading}
            />
          )
        }
        main={
          <>
            {threadsError && (
              <p className="mb-3 rounded bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                Existing review threads could not be loaded: {threadsError}
              </p>
            )}
            {stateError && (
              <p
                className="mb-3 flex items-start gap-2 rounded bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
                role="alert"
              >
                <span className="min-w-0 flex-1">{stateError}</span>
                {errorNeedsRefresh && (
                  <button
                    type="button"
                    className="shrink-0 text-xs font-medium hover:underline"
                    disabled={refreshing}
                    onClick={() => {
                      dismissError();
                      void refresh();
                    }}
                  >
                    {refreshing ? 'Refreshing…' : 'Refresh'}
                  </button>
                )}
                <button
                  type="button"
                  className="shrink-0 text-xs hover:underline"
                  onClick={dismissError}
                >
                  Dismiss
                </button>
              </p>
            )}
            <ReReviewBanner />
            {main}
          </>
        }
      />
      {submitting && <SubmitModal onClose={() => setSubmitting(false)} />}
      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
    </>
  );
}

export function App() {
  return (
    <ReviewProvider>
      <AnalysisProvider>
        <ReviewStateProvider>
          <Review />
        </ReviewStateProvider>
      </AnalysisProvider>
    </ReviewProvider>
  );
}
