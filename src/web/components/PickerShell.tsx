import type { KeyboardEvent, ReactNode } from 'react';

const btn =
  'rounded border border-gray-300 bg-white px-2.5 py-1 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:hover:bg-gray-800';

/** Row styling shared by the pickers' list items. */
export function rowClass(active: boolean): string {
  return `block px-3 py-2 ${
    active ? 'bg-blue-50 dark:bg-blue-950/50' : 'hover:bg-gray-50 dark:hover:bg-gray-900'
  }`;
}

export const listClass =
  'divide-y divide-gray-200 rounded border border-gray-200 dark:divide-gray-800 dark:border-gray-800';

/** Page frame for the repository and PR pickers: title row, filter box, error, then the list. */
export function PickerShell(props: {
  title: string;
  /** Shown before the title, e.g. a link back to the previous picker. */
  back?: ReactNode;
  /** Shown after the title. */
  subtitle?: ReactNode;
  loading: boolean;
  onRefresh(): void;
  query: string;
  onQuery(q: string): void;
  onKeyDown(e: KeyboardEvent): void;
  placeholder: string;
  filterLabel: string;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {props.back}
        <h1 className="text-lg font-semibold">{props.title}</h1>
        {props.subtitle}
        <span className="flex-1" />
        <button type="button" className={btn} disabled={props.loading} onClick={props.onRefresh}>
          {props.loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      <input
        type="search"
        autoFocus
        value={props.query}
        onChange={(e) => props.onQuery(e.target.value)}
        onKeyDown={props.onKeyDown}
        placeholder={props.placeholder}
        aria-label={props.filterLabel}
        className="mb-3 w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
      />
      {props.error && (
        <p
          role="alert"
          className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
        >
          {props.error}
        </p>
      )}
      {props.children}
    </div>
  );
}
