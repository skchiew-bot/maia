import {
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { cx } from '../lib/dom';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  columnId: string;
  direction: SortDirection;
}

export interface DataTableColumn<T> {
  /** Stable id; used in sort state. */
  id: string;
  /** Header text. Keep it short — it doubles as the field label in the phone card layout. */
  header: string;
  /** Cell renderer. Return text or components; never build HTML strings from untrusted data. */
  cell: (row: T) => ReactNode;
  /** Sort key. Providing it makes the column sortable. `null`/`undefined` always sort last. */
  sortValue?: (row: T) => string | number | null | undefined;
  /** First sort direction when this column is chosen. Default `desc` for numeric columns, else `asc`. */
  firstSort?: SortDirection;
  /**
   * Wording for the phone sort menu as [ascending, descending], e.g. ['Most urgent first', 'Least urgent
   * first'] for a liveness column sorted by precedence. Default A → Z / Z → A, or low → high / high → low.
   */
  sortLabels?: readonly [string, string];
  /** Metric column: right-aligned with tabular numerals. */
  numeric?: boolean;
  /** Alignment override. */
  align?: 'start' | 'center' | 'end';
  /** CSS width, e.g. `120px` or `20%`. */
  width?: string;
  /** Visually hide the header text (e.g. an actions column); it is still announced. */
  hideHeader?: boolean;
  /** Leave this column out of the phone card layout. */
  hideOnMobile?: boolean;
  /**
   * The row's identifying column: shown as the card title on phones, and with `rowHref` it renders the real
   * link that keyboard and screen-reader users follow.
   */
  primary?: boolean;
}

export interface DataTableProps<T> {
  columns: readonly DataTableColumn<T>[];
  rows: readonly T[];
  /** Stable key per row. */
  rowKey: (row: T) => string;
  /** Accessible table name. Visually hidden unless `captionVisible`. */
  caption: string;
  captionVisible?: boolean;
  /** Controlled sort; pair with `onSortChange`. */
  sort?: SortState | null;
  /** Initial sort when uncontrolled. */
  defaultSort?: SortState;
  onSortChange?: (sort: SortState) => void;
  /** Rows arrive already sorted (server-side); headers only emit `onSortChange`. */
  manualSort?: boolean;
  /** Navigation target per row. Whole-row click navigates; the primary cell holds a real link. */
  rowHref?: (row: T) => string;
  /** Row action (open a drawer, select). Rows become focusable and activate on Enter/Space. */
  onRowClick?: (row: T) => void;
  /** Accessible label for activatable rows (used with `onRowClick`). */
  rowLabel?: (row: T) => string;
  /** Marks the row that is currently open/selected. */
  activeRowKey?: string;
  /** Tints rows needing attention; always pair with a badge/word in a cell. */
  rowTone?: (row: T) => 'warn' | 'danger' | undefined;
  /** Shown when `rows` is empty. Default: a quiet "Nothing to show" EmptyState. */
  empty?: ReactNode;
  /** Refetch in flight: previous rows stay at reduced opacity, no skeleton flash. */
  busy?: boolean;
  /**
   * Height limit for the scroll area (number = px). The header is sticky inside it — pass this for long
   * tables (audit, metering) so the column headers stay visible.
   */
  maxHeight?: number | string;
  className?: string;
}

function compareValues(a: string | number | null | undefined, b: string | number | null | undefined): number {
  const aNil = a === null || a === undefined || a === '';
  const bNil = b === null || b === undefined || b === '';
  if (aNil || bNil) return aNil === bNil ? 0 : aNil ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

const INTERACTIVE =
  'a,button,input,select,textarea,label,summary,[role="button"],[role="menuitem"],[role="checkbox"]';

/**
 * Compact (32px rows) data table with sortable headers (`aria-sort`), sticky header, row navigation, empty
 * and busy states. At ≤640px it re-flows into stacked cards using the column headers as field labels.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  captionVisible,
  sort: sortProp,
  defaultSort,
  onSortChange,
  manualSort,
  rowHref,
  onRowClick,
  rowLabel,
  activeRowKey,
  rowTone,
  empty,
  busy,
  maxHeight,
  className,
}: DataTableProps<T>) {
  const navigate = useNavigate();
  const sortSelectId = useId();
  const [innerSort, setInnerSort] = useState<SortState | null>(defaultSort ?? null);
  const sort = sortProp !== undefined ? sortProp : innerSort;

  const sorted = useMemo(() => {
    if (manualSort || !sort) return rows;
    const col = columns.find((c) => c.id === sort.columnId);
    if (!col?.sortValue) return rows;
    const get = col.sortValue;
    const dir = sort.direction === 'asc' ? 1 : -1;
    return rows
      .map((row, index) => ({ row, index, key: get(row) }))
      .sort((x, y) => {
        const nil = (v: unknown) => v === null || v === undefined || v === '';
        // Missing values sort last in both directions.
        if (nil(x.key) || nil(y.key)) return compareValues(x.key, y.key) || x.index - y.index;
        return compareValues(x.key, y.key) * dir || x.index - y.index;
      })
      .map((e) => e.row);
  }, [rows, columns, sort, manualSort]);

  const applySort = (next: SortState) => {
    if (sortProp === undefined) setInnerSort(next);
    onSortChange?.(next);
  };

  const toggleSort = (col: DataTableColumn<T>) => {
    if (sort?.columnId === col.id) {
      applySort({ columnId: col.id, direction: sort.direction === 'asc' ? 'desc' : 'asc' });
    } else {
      applySort({ columnId: col.id, direction: col.firstSort ?? (col.numeric ? 'desc' : 'asc') });
    }
  };

  const sortable = columns.filter((c) => c.sortValue);
  const primaryId = (columns.find((c) => c.primary) ?? columns[0])?.id;
  const clickable = Boolean(rowHref || onRowClick);

  const activate = (row: T, e: MouseEvent | KeyboardEvent) => {
    if (onRowClick) {
      onRowClick(row);
      return;
    }
    if (!rowHref) return;
    const href = rowHref(row);
    if ('metaKey' in e && (e.metaKey || e.ctrlKey)) window.open(href, '_blank', 'noopener');
    else navigate(href);
  };

  const handleRowClick = (row: T) => (e: MouseEvent<HTMLTableRowElement>) => {
    // Clicks on links/buttons inside the row keep their own behaviour; selecting text is not a click.
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    if (window.getSelection?.()?.toString()) return;
    activate(row, e);
  };

  const onRowKeyDown = (row: T) => (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate(row, e);
    }
  };

  const scrollStyle: CSSProperties | undefined =
    maxHeight !== undefined
      ? { maxHeight: typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight }
      : undefined;

  return (
    <div className={cx('aoc-dt', busy && 'is-busy', className)} aria-busy={busy || undefined}>
      {sortable.length > 0 && (
        <div className="aoc-dt__mobile-sort">
          <label htmlFor={sortSelectId}>Sort</label>
          <select
            id={sortSelectId}
            value={sort ? `${sort.columnId}:${sort.direction}` : ''}
            onChange={(e) => {
              const [columnId, direction] = e.target.value.split(':');
              if (columnId && (direction === 'asc' || direction === 'desc'))
                applySort({ columnId, direction });
            }}
          >
            {!sort && <option value="">Default order</option>}
            {sortable.flatMap((c) => {
              const [asc, desc] =
                c.sortLabels ?? (c.numeric ? ['low → high', 'high → low'] : ['A → Z', 'Z → A']);
              return [
                <option key={`${c.id}:asc`} value={`${c.id}:asc`}>
                  {c.header} ({asc})
                </option>,
                <option key={`${c.id}:desc`} value={`${c.id}:desc`}>
                  {c.header} ({desc})
                </option>,
              ];
            })}
          </select>
        </div>
      )}
      <div
        className={cx('aoc-dt__scroll', maxHeight !== undefined && 'aoc-dt__scroll--bounded')}
        style={scrollStyle}
      >
        <table className="aoc-dt__table" role="table">
          <caption className={captionVisible ? 'aoc-dt__caption' : 'aoc-sr-only'}>{caption}</caption>
          <thead role="rowgroup">
            <tr role="row">
              {columns.map((col) => {
                const active = sort?.columnId === col.id;
                const ariaSort = active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined;
                return (
                  <th
                    key={col.id}
                    role="columnheader"
                    scope="col"
                    aria-sort={ariaSort}
                    style={col.width ? { width: col.width } : undefined}
                    className={cx(
                      'aoc-dt__th',
                      (col.numeric || col.align === 'end') && 'is-end',
                      col.align === 'center' && 'is-center',
                    )}
                  >
                    {col.sortValue ? (
                      <button type="button" className="aoc-dt__sort" onClick={() => toggleSort(col)}>
                        <span className={col.hideHeader ? 'aoc-sr-only' : undefined}>{col.header}</span>
                        <Icon
                          name={active ? (sort.direction === 'asc' ? 'sort-asc' : 'sort-desc') : 'sort-none'}
                          size={12}
                          className={cx('aoc-dt__sort-icon', active && 'is-active')}
                        />
                      </button>
                    ) : (
                      <span className={col.hideHeader ? 'aoc-sr-only' : undefined}>{col.header}</span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody role="rowgroup">
            {sorted.length === 0 ? (
              <tr role="row" className="aoc-dt__empty-row">
                <td role="cell" colSpan={columns.length}>
                  {empty ?? <EmptyState title="Nothing to show" size="sm" />}
                </td>
              </tr>
            ) : (
              sorted.map((row) => {
                const key = rowKey(row);
                const tone = rowTone?.(row);
                return (
                  <tr
                    key={key}
                    role="row"
                    className={cx(
                      'aoc-dt__row',
                      clickable && 'is-clickable',
                      activeRowKey === key && 'is-active',
                      tone && `aoc-dt__row--${tone}`,
                    )}
                    aria-current={activeRowKey === key ? 'true' : undefined}
                    tabIndex={onRowClick ? 0 : undefined}
                    aria-label={onRowClick && rowLabel ? rowLabel(row) : undefined}
                    onClick={clickable ? handleRowClick(row) : undefined}
                    onKeyDown={onRowClick ? onRowKeyDown(row) : undefined}
                  >
                    {columns.map((col) => {
                      const content = col.cell(row);
                      const isPrimary = col.id === primaryId;
                      return (
                        <td
                          key={col.id}
                          role="cell"
                          data-label={col.header}
                          className={cx(
                            'aoc-dt__td',
                            (col.numeric || col.align === 'end') && 'is-end',
                            col.align === 'center' && 'is-center',
                            col.numeric && 'aoc-num',
                            isPrimary && 'is-primary',
                            col.hideOnMobile && 'is-hidden-mobile',
                          )}
                        >
                          {isPrimary && rowHref ? (
                            <Link to={rowHref(row)} className="aoc-dt__link">
                              {content}
                            </Link>
                          ) : (
                            content
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
