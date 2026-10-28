import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

/**
 * Arrow-key selection for a filtered list: ↑/↓ move, Enter calls `onEnter` with the active
 * index (or null when the list is empty). Rows mark themselves with `data-index`.
 */
export function useListNav(count: number, onEnter: (index: number | null) => void) {
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const current = Math.min(active, Math.max(count - 1, 0));

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${current}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(Math.min(current + 1, count - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(Math.max(current - 1, 0));
    } else if (e.key === 'Enter') {
      onEnter(count > 0 ? current : null);
    }
  };

  return { current, setActive, listRef, onKeyDown };
}
