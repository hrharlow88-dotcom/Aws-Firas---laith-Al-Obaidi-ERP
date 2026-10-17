import { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useSession } from '../lib/session';

export interface PickedEmployee {
  id: string;
  fullName: string;
  employeeNo: string;
}

/** Searches employees by name or number and returns the chosen one. */
export function EmployeePicker({ value, onChange, placeholder = 'ابحث بالاسم أو الرقم…', exclude, label }: {
  value: PickedEmployee | null;
  onChange: (employee: PickedEmployee | null) => void;
  placeholder?: string;
  exclude?: string;
  label: string;
}) {
  const session = useSession();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PickedEmployee[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open || query.trim().length < 1) {
      setResults([]);
      return;
    }
    let current = true;
    const timer = window.setTimeout(() => {
      session.call<{ data: PickedEmployee[] }>(`/employees?pageSize=12&search=${encodeURIComponent(query.trim())}`)
        .then((result) => { if (current) setResults(result.data.filter((item) => item.id !== exclude)); })
        .catch(() => undefined);
    }, 220);
    return () => { current = false; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open, exclude]);

  if (value) {
    return (
      <div className="field"><span>{label}</span>
        <div className="picked">
          <span><strong>{value.fullName}</strong><small>{value.employeeNo}</small></span>
          <button type="button" className="icon-button" aria-label="إزالة" onClick={() => onChange(null)}><X size={15} /></button>
        </div>
      </div>
    );
  }
  return (
    <div className="field picker"><span>{label}</span>
      <label className="search-field"><Search size={15} />
        <input
          value={query}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {open && results.length > 0 && <div className="picker-results" role="listbox">
        {results.map((item) => (
          <button type="button" role="option" aria-selected="false" key={item.id} onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange(item); setQuery(''); setOpen(false); }}>
            <strong>{item.fullName}</strong><small>{item.employeeNo}</small>
          </button>
        ))}
      </div>}
    </div>
  );
}
