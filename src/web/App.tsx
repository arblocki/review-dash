import { useCallback, useMemo, useState } from 'react';
import { AnalysisProvider, useAnalysis } from './analysis';
import { AnalysisBar } from './components/AnalysisBar';
import {
  AnalysisBanner,
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
import { fileThreadOwners } from './lib/sections';
import { ReviewProvider, useReview } from './state';

function Review() {
  const { files, threadsError } = useReview();
  const { result, loading, error, stale } = useAnalysis();
  const [submitting, setSubmitting] = useState(false);
  const [choice, setChoice] = useState<ViewMode | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Verify checks are local for now; ids are `verifyId(groupKey, index, text)` so they can be persisted.
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());

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
  const toggleVerify = useCallback(
    (id: string) =>
      setChecked((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );

  let main;
  if (view === 'file') {
    main = (
      <>
        <AnalysisBanner />
        {error && !loading && <AnalysisError view={view} onView={setChoice} />}
        <AllFilesDiff />
      </>
    );
  } else if (group && analysis) {
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
          checked={checked}
          onToggleVerify={toggleVerify}
          onSelect={select}
        />
      </>
    );
  } else if (error && !loading) {
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
            extra={<AnalysisBar view={view} onView={setChoice} />}
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
            {main}
          </>
        }
      />
      {submitting && <SubmitModal onClose={() => setSubmitting(false)} />}
    </>
  );
}

export function App() {
  return (
    <ReviewProvider>
      <AnalysisProvider>
        <Review />
      </AnalysisProvider>
    </ReviewProvider>
  );
}
