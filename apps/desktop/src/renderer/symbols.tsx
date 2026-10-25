import { Star, type LucideProps } from "lucide-react";

// The browser's icons (PLX-970), under the names of Material Symbols, which Chromium and Helium
// draw theirs in, so its code reads as theirs. Each is a lucide icon, as every other icon in the
// app is (0085).
export {
  AppWindow as Tab,
  ArrowLeft as ArrowBack,
  ArrowRight as ArrowForward,
  Bookmark,
  Check,
  ChevronDown as ArrowDown,
  ChevronRight,
  ChevronUp as ArrowUp,
  ChevronsRight as DoubleArrowRight,
  CircleUser as AccountCircle,
  Code,
  Download,
  EllipsisVertical as MoreVert,
  ExternalLink as OpenInNew,
  Folder,
  FolderOpen,
  FolderPlus as CreateNewFolder,
  Globe as Public,
  History,
  House as Home,
  LogOut as Logout,
  Minus as Remove,
  Monitor as DesktopWindows,
  MoveDiagonal2 as Resize,
  Palette,
  PanelRightOpen as RightPanelOpen,
  PanelTop as SplitscreenTop,
  Pencil as Edit,
  Pin as Keep,
  PinOff as KeepOff,
  Plus as Add,
  Printer as Print,
  Puzzle as Extension,
  RectangleHorizontal as Rectangle,
  RotateCw as Refresh,
  Search,
  Settings,
  Star,
  Store as Storefront,
  Trash2 as Delete,
  Trash2 as DeleteHistory,
  UserCog as ManageAccounts,
  UserPlus as PersonAdd,
  X as Close,
  X as CloseSmall,
  ZoomIn,
} from "lucide-react";

/** Star, filled: a bookmarked page. */
export function StarFilled(props: LucideProps) {
  return <Star fill="currentColor" {...props} />;
}
