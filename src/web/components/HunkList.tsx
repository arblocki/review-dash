import { useMemo } from 'react';
import type { DiffSection } from '../lib/sections';
import { useReview } from '../state';
import { fileAnchorId, FileDiff } from './FileDiff';

/**
 * Renders file headers with an arbitrary list of hunks each. The main view passes every file;
 * a group card passes `sectionsFromHunkIds(files, group.hunkIds)`.
 */
export function HunkList({
  sections,
  fileThreadPaths,
}: {
  sections: DiffSection[];
  /** Paths whose file-level discussion this list renders; every path when omitted. */
  fileThreadPaths?: ReadonlySet<string>;
}) {
  return (
    <div className="space-y-4">
      {sections.map((s) => (
        <FileDiff
          key={`${s.file.path}:${s.hunks.map((h) => h.id).join(',')}`}
          file={s.file}
          hunks={s.hunks}
          anchorId={s.anchorId}
          showFileThreads={!fileThreadPaths || fileThreadPaths.has(s.file.path)}
        />
      ))}
    </div>
  );
}

/** Every changed file, with anchors so the file list can scroll to them. */
export function AllFilesDiff() {
  const { files } = useReview();
  const sections = useMemo(
    () => files.map((file) => ({ file, hunks: file.hunks, anchorId: fileAnchorId(file.path) })),
    [files],
  );
  return <HunkList sections={sections} />;
}
