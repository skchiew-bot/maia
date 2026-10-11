/**
 * AOC design-system primitives. Pages are composed only from these, the chart kit (`../charts`) and the data
 * layer (`../api`). See every primitive rendered with sample data at `/dev/gallery`.
 *
 * How a page is built (src/pages/<area>/<Name>Page.tsx, default export):
 * 1. `<PageHeader title subtitle actions breadcrumbs meta />` first — it owns the `<h1>` and the tab title.
 * 2. Optional `<FilterBar>` (time range first) scoping everything below it.
 * 3. Optional `<KpiStrip>` of `<KpiTile>`s — values always as text.
 * 4. A `<WidgetGrid>` of `<Widget span>` cards holding charts, `<DataTable>`s and `<RankedList>`s.
 * 5. Data from `useResource(path, { refreshOn })` rendered through `<ResourceView>` — no polling, no spinners.
 * Rules: liveness is always `<LivenessBadge>`; money is `<Money>` (notional when synthetic); ages are
 * `<RelativeTime>`; hashes are `<CopyableHash>`; token counts are `<TokenCount>`; colour carries meaning only;
 * no idle animation; page CSS (if any) lives next to the page and is prefixed with the area name.
 */
export { Icon, type IconName, type IconProps } from './Icon';
export type { Tone, StatusTone } from './tone';
export {
  Button,
  ButtonLink,
  IconButton,
  type ButtonLinkProps,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
  type IconButtonProps,
} from './Button';
export { Badge, CountBadge, type BadgeProps, type CountBadgeProps } from './Badge';
export { Chip, Kbd, type ChipProps, type KbdProps } from './Chip';
export { Tooltip, type TooltipProps } from './Tooltip';
export { PageHeader, type Crumb, type PageHeaderProps } from './PageHeader';
export { Widget, WidgetGrid, type WidgetGridProps, type WidgetProps, type WidgetSpan } from './Widget';
export { KpiStrip, KpiTile, type KpiDelta, type KpiStripProps, type KpiTileProps } from './KpiStrip';
export {
  DataTable,
  type DataTableColumn,
  type DataTableProps,
  type SortDirection,
  type SortState,
} from './DataTable';
export {
  Tabs,
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentedOption,
  type TabItem,
  type TabsProps,
} from './Tabs';
export { Menu, type MenuItem, type MenuProps } from './Menu';
export { Dialog, Drawer, type DialogProps, type DrawerProps } from './Dialog';
export { ToastProvider, useToast, type ToastApi, type ToastInput } from './Toast';
export {
  EmptyState,
  ErrorState,
  InlineAlert,
  describeError,
  type EmptyStateProps,
  type ErrorStateProps,
  type InlineAlertProps,
} from './EmptyState';
export { CopyableHash, type CopyableHashProps } from './CopyableHash';
export { HiddenTextWarning, RevealedText } from './RevealedText';
export { RelativeTime, type RelativeTimeProps } from './RelativeTime';
export { Money, type MoneyProps } from './Money';
export { TokenCount, type TokenCountProps } from './TokenCount';
export { ProgressBar, ETA_MIN_DONE, type ProgressBarProps } from './ProgressBar';
export {
  Checkbox,
  Field,
  Select,
  TextArea,
  TextField,
  type CheckboxProps,
  type FieldControlProps,
  type FieldProps,
  type SelectOption,
  type SelectProps,
  type TextAreaProps,
  type TextFieldProps,
} from './Field';
export {
  DescriptionList,
  FilterBar,
  Stack,
  type DescriptionItem,
  type DescriptionListProps,
  type FilterBarProps,
  type StackProps,
} from './Layout';
export { ResourceView, type ResourceViewProps } from './ResourceView';
export {
  RankedList,
  SEVERITY_META,
  type RankedItem,
  type RankedListProps,
  type Severity,
} from './RankedList';
export {
  RequestStatusBadge,
  REQUEST_STATUS_META,
  type RequestStatus,
  type RequestStatusBadgeProps,
} from './RequestStatusBadge';
export * from './liveness';
export {
  formatAge,
  formatClock,
  formatCompact,
  formatDateTime,
  formatDuration,
  formatInteger,
  formatMyr,
  formatNumber,
  formatPercent,
  formatShortDate,
  formatSignedPercent,
  formatTokens,
  formatUsd,
  shortHash,
  toEpoch,
  type Instant,
} from '../lib/format';
export { ClockProvider, fixedClock, systemClock, useClock, useNow, type Clock } from '../lib/clock';
