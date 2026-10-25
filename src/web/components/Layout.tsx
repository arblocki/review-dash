import type { ReactNode } from 'react';

/**
 * App shell: sticky header on top, a sticky left rail, and the scrolling main column.
 * The rail is generic (a file list now, the group rail later).
 */
export function Layout({
  header,
  rail,
  main,
}: {
  header: ReactNode;
  rail: ReactNode;
  main: ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-gray-200 bg-white/95 backdrop-blur dark:border-gray-800 dark:bg-gray-950/95">
        {header}
      </header>
      <div className="flex items-start">
        <aside
          className="sticky top-[var(--header-h)] hidden h-[calc(100vh-var(--header-h))] w-72 shrink-0 overflow-y-auto border-r border-gray-200 md:block dark:border-gray-800"
          aria-label="Navigation"
        >
          {rail}
        </aside>
        <main className="min-w-0 flex-1 px-4 py-4">{main}</main>
      </div>
    </div>
  );
}
