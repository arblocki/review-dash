import { SHORTCUTS } from '../lib/keyboard';

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 sm:pt-24"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      data-testid="help-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-4 shadow-xl dark:border-gray-700 dark:bg-gray-900">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Keyboard shortcuts</h2>
          <button type="button" className="text-gray-500" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <dl className="space-y-1.5 text-sm">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="flex items-center gap-3">
              <dt className="w-20 shrink-0">
                <kbd className="rounded border border-gray-300 bg-gray-50 px-1.5 py-0.5 font-mono text-xs dark:border-gray-600 dark:bg-gray-800">
                  {s.keys}
                </kbd>
              </dt>
              <dd>{s.label}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          Shortcuts are off while you type in a comment box.
        </p>
      </div>
    </div>
  );
}
