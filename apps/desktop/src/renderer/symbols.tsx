import {
  ArrowDown01Icon,
  ArrowLeft02Icon,
  ArrowRight02Icon,
  ArrowRightDoubleIcon,
  ArrowUp01Icon,
  Bookmark01Icon,
  BrowserIcon,
  CheckIcon,
  ChevronRightIcon,
  CodeIcon,
  ComputerIcon,
  Delete02Icon,
  Download01Icon,
  Folder01Icon,
  FolderAddIcon,
  FolderOpenIcon,
  Globe02Icon,
  HistoryIcon,
  Home01Icon,
  LayoutTwoRowIcon,
  LinkSquare02Icon,
  Logout01Icon,
  MinusSignIcon,
  MoreVerticalIcon,
  PaintBoardIcon,
  PanelRightOpenIcon,
  PencilEdit01Icon,
  PinIcon,
  PinOffIcon,
  PlusSignIcon,
  PrinterIcon,
  PuzzleIcon,
  RectangularIcon,
  RefreshIcon,
  ArrowExpandDiagonal01Icon,
  Search01Icon,
  Settings01Icon,
  StarIcon,
  Store01Icon,
  UserAdd01Icon,
  UserCircleIcon,
  UserSettings01Icon,
  XIcon,
  ZoomInIcon,
} from "@hugeicons/core-free-icons";

import { icon, type IconProps } from "./icons";

// The browser's icons (PLX-970), under the names of Material Symbols, which Chromium and Helium
// draw theirs in, so its code reads as theirs. Each is Hugeicons' stroke-rounded glyph (0086), as
// every other icon in the app is.

export const Add = icon(PlusSignIcon, "add");
export const ArrowBack = icon(ArrowLeft02Icon, "arrow-back");
export const ArrowDown = icon(ArrowDown01Icon, "arrow-down");
export const ArrowForward = icon(ArrowRight02Icon, "arrow-forward");
export const ArrowUp = icon(ArrowUp01Icon, "arrow-up");
export const Bookmark = icon(Bookmark01Icon, "bookmark");
export const Check = icon(CheckIcon, "check");
export const ChevronRight = icon(ChevronRightIcon, "chevron-right");
export const Close = icon(XIcon, "close");
export const CloseSmall = icon(XIcon, "close-small");
export const Code = icon(CodeIcon, "code");
export const CreateNewFolder = icon(FolderAddIcon, "create-new-folder");
export const Delete = icon(Delete02Icon, "delete");
export const DoubleArrowRight = icon(ArrowRightDoubleIcon, "double-arrow-right");
export const Download = icon(Download01Icon, "download");
export const Edit = icon(PencilEdit01Icon, "edit");
export const Extension = icon(PuzzleIcon, "extension");
export const Folder = icon(Folder01Icon, "folder");
export const History = icon(HistoryIcon, "history");
export const Home = icon(Home01Icon, "home");
export const MoreVert = icon(MoreVerticalIcon, "more-vert");
export const OpenInNew = icon(LinkSquare02Icon, "open-in-new");
export const Print = icon(PrinterIcon, "print");
export const Public = icon(Globe02Icon, "public");
export const Rectangle = icon(RectangularIcon, "rectangle");
export const Refresh = icon(RefreshIcon, "refresh");
export const Remove = icon(MinusSignIcon, "remove");
export const Search = icon(Search01Icon, "search");
export const SplitscreenTop = icon(LayoutTwoRowIcon, "splitscreen-top");
export const Star = icon(StarIcon, "star");
export const Tab = icon(BrowserIcon, "tab");
export const ZoomIn = icon(ZoomInIcon, "zoom-in");
export const DesktopWindows = icon(ComputerIcon, "desktop-windows");
export const RightPanelOpen = icon(PanelRightOpenIcon, "right-panel-open");
export const Resize = icon(ArrowExpandDiagonal01Icon, "resize");
export const FolderOpen = icon(FolderOpenIcon, "folder-open");
export const AccountCircle = icon(UserCircleIcon, "account-circle");
export const DeleteHistory = icon(Delete02Icon, "delete-history");
export const Keep = icon(PinIcon, "keep");
export const KeepOff = icon(PinOffIcon, "keep-off");
export const Logout = icon(Logout01Icon, "logout");
export const ManageAccounts = icon(UserSettings01Icon, "manage-accounts");
export const Palette = icon(PaintBoardIcon, "palette");
export const PersonAdd = icon(UserAdd01Icon, "person-add");
export const Settings = icon(Settings01Icon, "settings");
export const Storefront = icon(Store01Icon, "storefront");

/** Star, filled: a bookmarked page. */
export function StarFilled(props: IconProps) {
  return <Star fill="currentColor" {...props} />;
}
