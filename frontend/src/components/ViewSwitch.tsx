import { LayoutGrid, List, SquareKanban } from 'lucide-react';
import { useState } from 'react';

export type ViewMode = 'list' | 'kanban' | 'grid';

/** List / kanban / cards toggle, remembered per screen in this browser. */
export function useViewMode(key: string, initial: ViewMode = 'list'): [ViewMode, (mode: ViewMode) => void] {
  const storageKey = `erp.view.${key}`;
  const [mode, setMode] = useState<ViewMode>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return saved === 'list' || saved === 'kanban' || saved === 'grid' ? saved : initial;
    } catch { return initial; }
  });
  const change = (next: ViewMode) => {
    setMode(next);
    try { localStorage.setItem(storageKey, next); } catch { /* remembered for this visit only */ }
  };
  return [mode, change];
}

export function ViewSwitch({ value, onChange, modes = ['list', 'kanban', 'grid'] }: { value: ViewMode; onChange: (mode: ViewMode) => void; modes?: ViewMode[] }) {
  const items: Record<ViewMode, { icon: JSX.Element; label: string }> = {
    list: { icon: <List size={16} />, label: 'قائمة · List' },
    kanban: { icon: <SquareKanban size={16} />, label: 'كانبان · Kanban' },
    grid: { icon: <LayoutGrid size={16} />, label: 'بطاقات · Cards' },
  };
  return (
    <div className="view-switch" role="group" aria-label="طريقة العرض · View">
      {modes.map((mode) => <button key={mode} type="button" title={items[mode].label} aria-label={items[mode].label} aria-pressed={value === mode} onClick={() => onChange(mode)}>{items[mode].icon}</button>)}
    </div>
  );
}
