/**
 * Makes every table usable on a phone without touching each screen.
 *
 * A table with a header row and up to CARD_MAX_COLUMNS columns becomes a list
 * of cards on narrow screens (each cell shows its column name beside it); a
 * wider one scrolls inside itself with the first column held in place. The
 * mode only takes effect under the phone breakpoint (responsive.css); on a
 * desktop the attributes change nothing.
 *
 * Only data-* attributes are written, which React leaves alone, so screens
 * keep rendering their tables exactly as before.
 */
const SKIP = '.payslip, .doc-sheet, .doc-wrap, .id-card, .calendar-grid, .archive-matrix, [data-rt-skip]';
const CARD_MAX_COLUMNS = 7;

function headerLabels(table: HTMLTableElement): string[] | null {
  const head = table.tHead;
  if (!head || !head.rows.length) return null;
  const row = head.rows[head.rows.length - 1];
  const labels: string[] = [];
  for (const cell of Array.from(row.cells)) {
    // innerText leaves out text hidden by the language choice, so the label
    // follows Arabic / English like the header itself.
    const text = (cell.innerText || cell.textContent || '').trim().split('\n')[0].trim();
    for (let span = 0; span < (cell.colSpan || 1); span += 1) labels.push(text);
  }
  return labels;
}

function prepare(table: HTMLTableElement): void {
  if (table.closest(SKIP)) return;
  const labels = headerLabels(table);
  const columns = labels?.length ?? table.rows[0]?.cells.length ?? 0;
  const mode = table.dataset.rtMode || (labels && columns <= CARD_MAX_COLUMNS ? 'cards' : 'scroll');
  if (table.dataset.rt !== mode) table.dataset.rt = mode;
  if (mode !== 'cards' || !labels) return;
  for (const body of Array.from(table.tBodies)) {
    for (const row of Array.from(body.rows)) {
      let column = 0;
      for (const cell of Array.from(row.cells)) {
        const label = cell.colSpan > 1 ? '' : labels[column] ?? '';
        if (cell.getAttribute('data-label') !== label) cell.setAttribute('data-label', label);
        column += cell.colSpan || 1;
      }
    }
  }
}

/** Watches the app for tables as screens render; returns the stop function. */
export function watchResponsiveTables(root: HTMLElement): () => void {
  let queued = 0;
  const run = () => {
    queued = 0;
    root.querySelectorAll('table').forEach((table) => prepare(table as HTMLTableElement));
  };
  const schedule = () => { if (!queued) queued = window.requestAnimationFrame(run); };
  const observer = new MutationObserver(schedule);
  // Only structure changes: the attributes this writes do not wake it again.
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  run();
  return () => { observer.disconnect(); if (queued) window.cancelAnimationFrame(queued); };
}
