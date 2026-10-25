import { useDrafts, useReview } from '../state';
import type { ParsedFile } from '../types';
import { fileAnchorId } from './FileDiff';

const STATUS: Record<string, { letter: string; cls: string }> = {
  added: { letter: 'A', cls: 'text-green-600 dark:text-green-400' },
  removed: { letter: 'D', cls: 'text-red-600 dark:text-red-400' },
  renamed: { letter: 'R', cls: 'text-blue-600 dark:text-blue-400' },
  copied: { letter: 'C', cls: 'text-blue-600 dark:text-blue-400' },
};

export function scrollToFile(path: string): void {
  document.getElementById(fileAnchorId(path))?.scrollIntoView({ block: 'start' });
}

/** Left-rail list of changed files; clicking scrolls the main column to that file. */
export function FileList({ files }: { files: ParsedFile[] }) {
  const { incomplete } = useReview();
  const drafts = useDrafts();
  const counts = new Map<string, number>();
  for (const d of drafts) if (d.body.trim()) counts.set(d.path, (counts.get(d.path) ?? 0) + 1);

  return (
    <nav className="py-2 text-sm">
      <div className="px-3 pb-1 text-xs font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">
        Files ({incomplete ? `${files.length} of ${incomplete.changedFiles}` : files.length})
      </div>
      <ul>
        {files.map((f) => {
          const s = STATUS[f.status] ?? { letter: 'M', cls: 'text-amber-600 dark:text-amber-400' };
          const slash = f.path.lastIndexOf('/');
          const count = counts.get(f.path);
          return (
            <li key={f.path}>
              <button
                type="button"
                title={f.path}
                onClick={() => scrollToFile(f.path)}
                className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-gray-100 dark:hover:bg-gray-900"
              >
                <span className={`w-3 shrink-0 font-mono text-xs font-bold ${s.cls}`}>
                  {s.letter}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-gray-500 dark:text-gray-400">
                    {slash >= 0 ? f.path.slice(0, slash + 1) : ''}
                  </span>
                  <span className="font-medium">{f.path.slice(slash + 1)}</span>
                </span>
                {count ? (
                  <span className="rounded-full bg-blue-600 px-1.5 text-xs text-white">
                    {count}
                  </span>
                ) : null}
                <span className="shrink-0 font-mono text-xs">
                  <span className="text-green-700 dark:text-green-400">+{f.additions}</span>{' '}
                  <span className="text-red-700 dark:text-red-400">−{f.deletions}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
