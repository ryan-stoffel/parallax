import {
  ArrowDownUp,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Copy,
  Download,
  Ellipsis,
  Folder,
  GitBranch,
  GitPullRequest,
  Info,
  LayoutGrid,
  LoaderCircle,
  MessageCircleQuestion,
  MessagesSquare,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  ScrollText,
  Search,
  Server,
  Settings,
  SquarePen,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
  type LucideIcon,
} from "lucide-react";

/**
 * One lucide icon for each concept the interface draws (0092), so the same idea never shows as
 * two icons. Draw one as `<icons.refresh aria-hidden />`. A concept that isn't here yet gets an
 * entry before its first use.
 */
export const icons = {
  /** Opens outside the app: a link to a page, a file in its own app. */
  external: ArrowUpRight,
  refresh: RefreshCw,
  /** Something that ran and failed: a check, a thread, an action. */
  failed: CircleX,
  /** Something that needs a look but didn't fail. */
  warning: TriangleAlert,
  /** An error message, as a toast or a line under a field shows it. */
  error: CircleAlert,
  success: CircleCheck,
  info: Info,
  /** Waiting on the user: a question or a permission. */
  question: MessageCircleQuestion,
  loading: LoaderCircle,
  terminal: SquareTerminal,
  back: ArrowLeft,
  forward: ArrowRight,
  thread: MessagesSquare,
  newThread: SquarePen,
  edit: Pencil,
  close: X,
  add: Plus,
  delete: Trash2,
  copy: Copy,
  done: Check,
  more: Ellipsis,
  search: Search,
  settings: Settings,
  /** A menu or a fold that opens downward. */
  expand: ChevronDown,
  /** A fold that opens to the side, or a row that leads somewhere. */
  next: ChevronRight,
  pin: Pin,
  unpin: PinOff,
  undo: Undo2,
  download: Download,
  pullRequest: GitPullRequest,
  branch: GitBranch,
  folder: Folder,
  host: Server,
  agent: Bot,
  /** Projects (0093): a folder of threads with shared files and instructions. */
  projects: LayoutGrid,
  /** Files attached or given, as a Project gives its threads. */
  files: Paperclip,
  /** Instructions a Project gives its threads. */
  instructions: ScrollText,
  /** The order a list sorts in. */
  sort: ArrowDownUp,
} as const satisfies Record<string, LucideIcon>;
