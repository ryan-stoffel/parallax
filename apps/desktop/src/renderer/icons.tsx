import { HugeiconsIcon, type HugeiconsIconProps, type IconSvgElement } from "@hugeicons/react";
import {
  Activity01Icon,
  AlarmClockIcon,
  AlertCircleIcon,
  AppWindowIcon,
  AppWindowMacIcon,
  AppleIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowDown02Icon,
  ArrowExpandDiagonal01Icon,
  ArrowLeft02Icon,
  ArrowLeftRightIcon,
  ArrowRight02Icon,
  ArrowShrink02Icon,
  ArrowUp02Icon,
  ArrowUpDownIcon,
  ArrowUpLeft01Icon,
  ArrowUpRight01Icon,
  Atom01Icon,
  Attachment01Icon,
  BanIcon,
  BellIcon,
  BikeIcon,
  BlocksIcon,
  BookOpen01Icon,
  Bookmark01Icon,
  BotIcon,
  BracesIcon,
  BrainIcon,
  Briefcase01Icon,
  BrushIcon,
  Bug01Icon,
  BuildingIcon,
  Calendar01Icon,
  CalendarClockIcon,
  CalendarDaysIcon,
  Camera01Icon,
  Car01Icon,
  CatIcon,
  ChartColumnIcon,
  ChartLineIcon,
  ChartNoAxesColumnIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ChevronsDownUpIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDollarSignIcon,
  CircleDotIcon,
  CircleIcon,
  CircleMinusIcon,
  CircleSlashIcon,
  CircleXIcon,
  ClipboardListIcon,
  Clock01Icon,
  CloudIcon,
  CloudUploadIcon,
  CodeIcon,
  CodeXmlIcon,
  Coffee01Icon,
  CompassIcon,
  ComponentIcon,
  CopyIcon,
  CornerUpRightIcon,
  CpuIcon,
  CreditCardIcon,
  CrownIcon,
  Cursor01Icon,
  DatabaseIcon,
  Delete02Icon,
  DicesIcon,
  Download01Icon,
  EarthIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  EyeIcon,
  FeatherIcon,
  File01Icon,
  FileArchiveIcon,
  FileCodeIcon,
  FileDiffIcon,
  FileImageIcon,
  FilePenIcon,
  FilePlusIcon,
  FileSearchIcon,
  FileSpreadsheetIcon,
  FileSymlinkIcon,
  FileTextIcon,
  Film01Icon,
  FingerprintPatternIcon,
  Flag01Icon,
  FlameIcon,
  FlaskConicalIcon,
  FlowerIcon,
  FoldVerticalIcon,
  Folder01Icon,
  FolderGit2Icon,
  FolderKanbanIcon,
  FolderOpenIcon,
  FolderOutputIcon,
  FolderPlusIcon,
  FolderSearchIcon,
  FolderTreeIcon,
  GamepadIcon,
  GaugeIcon,
  GemIcon,
  GhostIcon,
  GiftIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitCompareIcon,
  GitForkIcon,
  GitMergeIcon,
  GitPullRequestArrowIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  Globe02Icon,
  GraduationCapIcon,
  GripVerticalIcon,
  HammerIcon,
  HandIcon,
  HardDriveIcon,
  HeadphonesIcon,
  HeartIcon,
  HexagonIcon,
  Home01Icon,
  HourglassIcon,
  Image01Icon,
  ImageOffIcon,
  ImageUpIcon,
  Infinity01Icon,
  InfoIcon,
  KanbanIcon,
  Key01Icon,
  KeyRoundIcon,
  KeyboardIcon,
  LanguagesIcon,
  LaptopIcon,
  Layers01Icon,
  LayoutDashboardIcon,
  LayoutGridIcon,
  LayoutTwoColumnIcon,
  Leaf01Icon,
  LibraryIcon,
  LightbulbIcon,
  LinkIcon,
  ListChecksIcon,
  ListFilterIcon,
  ListRestartIcon,
  ListTodoIcon,
  LoaderCircleIcon,
  Location01Icon,
  LockIcon,
  LockOpenIcon,
  LogInIcon,
  LogOutIcon,
  Mail01Icon,
  MapIcon as MapGlyph,
  Medal01Icon,
  Megaphone01Icon,
  MessageCircleQuestionMarkIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  Mic01Icon,
  MonitorIcon,
  MoonIcon,
  MountainIcon,
  MousePointerClickIcon,
  MusicIcon,
  NetworkIcon,
  NotebookPenIcon,
  Orbit01Icon,
  PackageIcon,
  PaletteIcon,
  PanelBottomIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelRightIcon,
  PauseCircleIcon,
  PawPrintIcon,
  PenTool01Icon,
  PencilEdit02Icon,
  PencilLineIcon,
  PieChartIcon,
  PiggyBankIcon,
  PinIcon,
  PinOffIcon,
  PineTreeIcon,
  Pizza01Icon,
  PlaneIcon,
  PlayIcon,
  PlugIcon,
  PlusIcon,
  PowerIcon,
  Presentation01Icon,
  PuzzleIcon,
  RabbitIcon,
  RefreshCwIcon,
  RocketIcon,
  RotateCcwIcon,
  RotateCwIcon,
  SchoolIcon,
  Search01Icon,
  SendIcon,
  ServerIcon,
  Settings01Icon,
  ShapesIcon,
  Shield01Icon,
  ShieldCheckIcon,
  ShieldQuestionMarkIcon,
  ShieldXIcon,
  ShoppingCart01Icon,
  SlidersHorizontalIcon,
  SmartphoneIcon,
  SmileIcon,
  SparklesIcon,
  SproutIcon,
  SquareDashedIcon,
  SquareIcon,
  SquareKanbanIcon,
  SquarePenIcon,
  SquareTerminalIcon,
  StarIcon,
  StarOffIcon,
  Store01Icon,
  Sun01Icon,
  SunMoonIcon,
  SunriseIcon,
  SunsetIcon,
  Tablet01Icon,
  Tag01Icon,
  Target01Icon,
  Telescope01Icon,
  TerminalIcon,
  TextSearchIcon,
  ThreeDRotateIcon,
  ThumbsUpIcon,
  Timer01Icon,
  TimerOffIcon,
  TrendingUpIcon,
  TriangleAlertIcon,
  TriangleIcon,
  TrophyIcon,
  TypeIcon,
  Undo02Icon,
  UnfoldMoreIcon,
  UngroupIcon,
  UserCircleIcon,
  UserIcon,
  UserPlusIcon,
  UsersIcon,
  UtensilsIcon,
  Wallet01Icon,
  WandSparklesIcon,
  WavesIcon,
  Wifi01Icon,
  WorkflowIcon,
  Wrench01Icon,
  XIcon,
  ZapIcon,
} from "@hugeicons/core-free-icons";
import type { FC, SVGProps } from "react";

// Every interface icon, from Hugeicons' stroke-rounded set (0086), under the names the app imports.
// Each takes an SVG's props: its class sizes and colors it, `strokeWidth` thins or thickens it, and
// `data-icon` names it, as `square-terminal`, for tests. Brand logos and file-type icons are their
// own.

export type IconProps = SVGProps<SVGSVGElement>;
export type IconComponent = FC<IconProps>;

/** An icon component drawing `svg`, named `name` in its `data-icon`. */
export function icon(svg: IconSvgElement, name: string): IconComponent {
  const Icon = (props: IconProps) => (
    <HugeiconsIcon icon={svg} data-icon={name} {...(props as Omit<HugeiconsIconProps, "icon">)} />
  );
  Icon.displayName = name;
  return Icon;
}

export const Activity = icon(Activity01Icon, "activity");
export const AlarmClock = icon(AlarmClockIcon, "alarm-clock");
export const AppWindow = icon(AppWindowIcon, "app-window");
export const AppWindowMac = icon(AppWindowMacIcon, "app-window-mac");
export const Apple = icon(AppleIcon, "apple");
export const Archive = icon(ArchiveIcon, "archive");
export const ArchiveRestore = icon(ArchiveRestoreIcon, "archive-restore");
export const ArrowDown = icon(ArrowDown02Icon, "arrow-down");
export const ArrowDownUp = icon(ArrowUpDownIcon, "arrow-down-up");
export const ArrowLeft = icon(ArrowLeft02Icon, "arrow-left");
export const ArrowLeftRight = icon(ArrowLeftRightIcon, "arrow-left-right");
export const ArrowRight = icon(ArrowRight02Icon, "arrow-right");
export const ArrowUp = icon(ArrowUp02Icon, "arrow-up");
export const ArrowUpLeft = icon(ArrowUpLeft01Icon, "arrow-up-left");
export const ArrowUpRight = icon(ArrowUpRight01Icon, "arrow-up-right");
export const Atom = icon(Atom01Icon, "atom");
export const Ban = icon(BanIcon, "ban");
export const Bell = icon(BellIcon, "bell");
export const Bike = icon(BikeIcon, "bike");
export const Blocks = icon(BlocksIcon, "blocks");
export const BookOpen = icon(BookOpen01Icon, "book-open");
export const Bookmark = icon(Bookmark01Icon, "bookmark");
export const Bot = icon(BotIcon, "bot");
export const Braces = icon(BracesIcon, "braces");
export const Brain = icon(BrainIcon, "brain");
export const Briefcase = icon(Briefcase01Icon, "briefcase");
export const Brush = icon(BrushIcon, "brush");
export const Bug = icon(Bug01Icon, "bug");
export const Building = icon(BuildingIcon, "building");
export const Calendar = icon(Calendar01Icon, "calendar");
export const CalendarClock = icon(CalendarClockIcon, "calendar-clock");
export const CalendarDays = icon(CalendarDaysIcon, "calendar-days");
export const Camera = icon(Camera01Icon, "camera");
export const Car = icon(Car01Icon, "car");
export const Cat = icon(CatIcon, "cat");
export const ChartColumn = icon(ChartColumnIcon, "chart-column");
export const ChartLine = icon(ChartLineIcon, "chart-line");
export const ChartNoAxesColumn = icon(ChartNoAxesColumnIcon, "chart-no-axes-column");
export const ChartPie = icon(PieChartIcon, "chart-pie");
export const Check = icon(CheckIcon, "check");
export const ChevronDown = icon(ChevronDownIcon, "chevron-down");
export const ChevronLeft = icon(ChevronLeftIcon, "chevron-left");
export const ChevronRight = icon(ChevronRightIcon, "chevron-right");
export const ChevronUp = icon(ChevronUpIcon, "chevron-up");
export const ChevronsDownUp = icon(ChevronsDownUpIcon, "chevrons-down-up");
export const ChevronsUpDown = icon(UnfoldMoreIcon, "chevrons-up-down");
export const Circle = icon(CircleIcon, "circle");
export const CircleAlert = icon(AlertCircleIcon, "circle-alert");
export const CircleCheck = icon(CircleCheckIcon, "circle-check");
export const CircleDashed = icon(CircleDashedIcon, "circle-dashed");
export const CircleDollarSign = icon(CircleDollarSignIcon, "circle-dollar-sign");
export const CircleDot = icon(CircleDotIcon, "circle-dot");
export const CircleMinus = icon(CircleMinusIcon, "circle-minus");
export const CirclePause = icon(PauseCircleIcon, "circle-pause");
export const CircleSlash = icon(CircleSlashIcon, "circle-slash");
export const CircleUser = icon(UserCircleIcon, "circle-user");
export const CircleX = icon(CircleXIcon, "circle-x");
export const ClipboardList = icon(ClipboardListIcon, "clipboard-list");
export const Clock = icon(Clock01Icon, "clock");
export const Cloud = icon(CloudIcon, "cloud");
export const CloudUpload = icon(CloudUploadIcon, "cloud-upload");
export const Code = icon(CodeIcon, "code");
export const CodeXml = icon(CodeXmlIcon, "code-xml");
export const Coffee = icon(Coffee01Icon, "coffee");
export const Columns2 = icon(LayoutTwoColumnIcon, "columns-2");
export const Compass = icon(CompassIcon, "compass");
export const Component = icon(ComponentIcon, "component");
export const Copy = icon(CopyIcon, "copy");
export const CornerUpRight = icon(CornerUpRightIcon, "corner-up-right");
export const Cpu = icon(CpuIcon, "cpu");
export const CreditCard = icon(CreditCardIcon, "credit-card");
export const Crown = icon(CrownIcon, "crown");
export const Database = icon(DatabaseIcon, "database");
export const Dices = icon(DicesIcon, "dices");
export const Dog = icon(PawPrintIcon, "dog");
export const Download = icon(Download01Icon, "download");
export const Earth = icon(EarthIcon, "earth");
export const Ellipsis = icon(EllipsisIcon, "ellipsis");
export const ExternalLink = icon(ExternalLinkIcon, "external-link");
export const Eye = icon(EyeIcon, "eye");
export const FaceSlightlySmiling = icon(SmileIcon, "face-slightly-smiling");
export const Feather = icon(FeatherIcon, "feather");
export const File = icon(File01Icon, "file");
export const FileArchive = icon(FileArchiveIcon, "file-archive");
export const FileCode = icon(FileCodeIcon, "file-code");
export const FileDiff = icon(FileDiffIcon, "file-diff");
export const FileImage = icon(FileImageIcon, "file-image");
export const FilePen = icon(FilePenIcon, "file-pen");
export const FilePlus = icon(FilePlusIcon, "file-plus");
export const FileSearch = icon(FileSearchIcon, "file-search");
export const FileSpreadsheet = icon(FileSpreadsheetIcon, "file-spreadsheet");
export const FileSymlink = icon(FileSymlinkIcon, "file-symlink");
export const FileText = icon(FileTextIcon, "file-text");
export const Film = icon(Film01Icon, "film");
export const FingerprintPattern = icon(FingerprintPatternIcon, "fingerprint-pattern");
export const Flag = icon(Flag01Icon, "flag");
export const Flame = icon(FlameIcon, "flame");
export const FlaskConical = icon(FlaskConicalIcon, "flask-conical");
export const Flower2 = icon(FlowerIcon, "flower-2");
export const FoldVertical = icon(FoldVerticalIcon, "fold-vertical");
export const Folder = icon(Folder01Icon, "folder");
export const FolderGit2 = icon(FolderGit2Icon, "folder-git-2");
export const FolderKanban = icon(FolderKanbanIcon, "folder-kanban");
export const FolderOpen = icon(FolderOpenIcon, "folder-open");
export const FolderOutput = icon(FolderOutputIcon, "folder-output");
export const FolderPlus = icon(FolderPlusIcon, "folder-plus");
export const FolderSearch = icon(FolderSearchIcon, "folder-search");
export const FolderTree = icon(FolderTreeIcon, "folder-tree");
export const Gamepad2 = icon(GamepadIcon, "gamepad-2");
export const Gauge = icon(GaugeIcon, "gauge");
export const Gem = icon(GemIcon, "gem");
export const Ghost = icon(GhostIcon, "ghost");
export const Gift = icon(GiftIcon, "gift");
export const GitBranch = icon(GitBranchIcon, "git-branch");
export const GitCommitHorizontal = icon(GitCommitHorizontalIcon, "git-commit-horizontal");
export const GitCompare = icon(GitCompareIcon, "git-compare");
export const GitFork = icon(GitForkIcon, "git-fork");
export const GitMerge = icon(GitMergeIcon, "git-merge");
export const GitPullRequest = icon(GitPullRequestIcon, "git-pull-request");
export const GitPullRequestArrow = icon(GitPullRequestArrowIcon, "git-pull-request-arrow");
export const GitPullRequestClosed = icon(GitPullRequestClosedIcon, "git-pull-request-closed");
export const GitPullRequestDraft = icon(GitPullRequestDraftIcon, "git-pull-request-draft");
export const Globe = icon(Globe02Icon, "globe");
export const GraduationCap = icon(GraduationCapIcon, "graduation-cap");
export const GripVertical = icon(GripVerticalIcon, "grip-vertical");
export const Hammer = icon(HammerIcon, "hammer");
export const Hand = icon(HandIcon, "hand");
export const HardDrive = icon(HardDriveIcon, "hard-drive");
export const Headphones = icon(HeadphonesIcon, "headphones");
export const Heart = icon(HeartIcon, "heart");
export const Hexagon = icon(HexagonIcon, "hexagon");
export const Hourglass = icon(HourglassIcon, "hourglass");
export const House = icon(Home01Icon, "house");
export const Image = icon(Image01Icon, "image");
export const ImageIcon = icon(Image01Icon, "image");
export const ImageOff = icon(ImageOffIcon, "image-off");
export const ImageUp = icon(ImageUpIcon, "image-up");
export const InfinityIcon = icon(Infinity01Icon, "infinity");
export const Info = icon(InfoIcon, "info");
export const Kanban = icon(KanbanIcon, "kanban");
export const Key = icon(Key01Icon, "key");
export const KeyRound = icon(KeyRoundIcon, "key-round");
export const Keyboard = icon(KeyboardIcon, "keyboard");
export const Languages = icon(LanguagesIcon, "languages");
export const Laptop = icon(LaptopIcon, "laptop");
export const Layers = icon(Layers01Icon, "layers");
export const LayoutDashboard = icon(LayoutDashboardIcon, "layout-dashboard");
export const LayoutGrid = icon(LayoutGridIcon, "layout-grid");
export const Leaf = icon(Leaf01Icon, "leaf");
export const Library = icon(LibraryIcon, "library");
export const Lightbulb = icon(LightbulbIcon, "lightbulb");
export const Link = icon(LinkIcon, "link");
export const ListChecks = icon(ListChecksIcon, "list-checks");
export const ListFilter = icon(ListFilterIcon, "list-filter");
export const ListRestart = icon(ListRestartIcon, "list-restart");
export const ListTodo = icon(ListTodoIcon, "list-todo");
export const LoaderCircle = icon(LoaderCircleIcon, "loader-circle");
export const Lock = icon(LockIcon, "lock");
export const LockOpen = icon(LockOpenIcon, "lock-open");
export const LogIn = icon(LogInIcon, "log-in");
export const LogOut = icon(LogOutIcon, "log-out");
export const Mail = icon(Mail01Icon, "mail");
export const MapIcon = icon(MapGlyph, "map");
export const MapPin = icon(Location01Icon, "map-pin");
export const Maximize2 = icon(ArrowExpandDiagonal01Icon, "maximize-2");
export const Medal = icon(Medal01Icon, "medal");
export const Megaphone = icon(Megaphone01Icon, "megaphone");
export const MessageCircleQuestion = icon(MessageCircleQuestionMarkIcon, "message-circle-question");
export const MessageCircleQuestionMark = icon(
  MessageCircleQuestionMarkIcon,
  "message-circle-question-mark",
);
export const MessageSquare = icon(MessageSquareIcon, "message-square");
export const MessagesSquare = icon(MessagesSquareIcon, "messages-square");
export const Mic = icon(Mic01Icon, "mic");
export const Minimize2 = icon(ArrowShrink02Icon, "minimize-2");
export const Monitor = icon(MonitorIcon, "monitor");
export const Moon = icon(MoonIcon, "moon");
export const Mountain = icon(MountainIcon, "mountain");
export const MousePointer2 = icon(Cursor01Icon, "mouse-pointer-2");
export const MousePointerClick = icon(MousePointerClickIcon, "mouse-pointer-click");
export const Music = icon(MusicIcon, "music");
export const Network = icon(NetworkIcon, "network");
export const NotebookPen = icon(NotebookPenIcon, "notebook-pen");
export const Orbit = icon(Orbit01Icon, "orbit");
export const Package = icon(PackageIcon, "package");
export const Palette = icon(PaletteIcon, "palette");
export const PanelBottom = icon(PanelBottomIcon, "panel-bottom");
export const PanelLeftClose = icon(PanelLeftCloseIcon, "panel-left-close");
export const PanelLeftOpen = icon(PanelLeftOpenIcon, "panel-left-open");
export const PanelRight = icon(PanelRightIcon, "panel-right");
export const Paperclip = icon(Attachment01Icon, "paperclip");
export const PenTool = icon(PenTool01Icon, "pen-tool");
export const Pencil = icon(PencilEdit02Icon, "pencil");
export const PencilLine = icon(PencilLineIcon, "pencil-line");
export const PiggyBank = icon(PiggyBankIcon, "piggy-bank");
export const Pin = icon(PinIcon, "pin");
export const PinOff = icon(PinOffIcon, "pin-off");
export const Pizza = icon(Pizza01Icon, "pizza");
export const Plane = icon(PlaneIcon, "plane");
export const Play = icon(PlayIcon, "play");
export const Plug = icon(PlugIcon, "plug");
export const Plus = icon(PlusIcon, "plus");
export const Power = icon(PowerIcon, "power");
export const Presentation = icon(Presentation01Icon, "presentation");
export const Puzzle = icon(PuzzleIcon, "puzzle");
export const Rabbit = icon(RabbitIcon, "rabbit");
export const RefreshCw = icon(RefreshCwIcon, "refresh-cw");
export const Rocket = icon(RocketIcon, "rocket");
export const Rotate3d = icon(ThreeDRotateIcon, "rotate-3d");
export const RotateCcw = icon(RotateCcwIcon, "rotate-ccw");
export const RotateCw = icon(RotateCwIcon, "rotate-cw");
export const School = icon(SchoolIcon, "school");
export const Search = icon(Search01Icon, "search");
export const Send = icon(SendIcon, "send");
export const Server = icon(ServerIcon, "server");
export const Settings = icon(Settings01Icon, "settings");
export const Shapes = icon(ShapesIcon, "shapes");
export const Shield = icon(Shield01Icon, "shield");
export const ShieldCheck = icon(ShieldCheckIcon, "shield-check");
export const ShieldQuestion = icon(ShieldQuestionMarkIcon, "shield-question");
export const ShieldX = icon(ShieldXIcon, "shield-x");
export const ShoppingCart = icon(ShoppingCart01Icon, "shopping-cart");
export const SlidersHorizontal = icon(SlidersHorizontalIcon, "sliders-horizontal");
export const Smartphone = icon(SmartphoneIcon, "smartphone");
export const Sparkles = icon(SparklesIcon, "sparkles");
export const Sprout = icon(SproutIcon, "sprout");
export const Square = icon(SquareIcon, "square");
export const SquareDashed = icon(SquareDashedIcon, "square-dashed");
export const SquareKanban = icon(SquareKanbanIcon, "square-kanban");
export const SquarePen = icon(SquarePenIcon, "square-pen");
export const SquareTerminal = icon(SquareTerminalIcon, "square-terminal");
export const Star = icon(StarIcon, "star");
export const StarOff = icon(StarOffIcon, "star-off");
export const Store = icon(Store01Icon, "store");
export const Sun = icon(Sun01Icon, "sun");
export const SunMoon = icon(SunMoonIcon, "sun-moon");
export const Sunrise = icon(SunriseIcon, "sunrise");
export const Sunset = icon(SunsetIcon, "sunset");
export const Tablet = icon(Tablet01Icon, "tablet");
export const Tag = icon(Tag01Icon, "tag");
export const Target = icon(Target01Icon, "target");
export const Telescope = icon(Telescope01Icon, "telescope");
export const Terminal = icon(TerminalIcon, "terminal");
export const TextSearch = icon(TextSearchIcon, "text-search");
export const ThumbsUp = icon(ThumbsUpIcon, "thumbs-up");
export const Timer = icon(Timer01Icon, "timer");
export const TimerOff = icon(TimerOffIcon, "timer-off");
export const Trash2 = icon(Delete02Icon, "trash-2");
export const TreePine = icon(PineTreeIcon, "tree-pine");
export const TrendingUp = icon(TrendingUpIcon, "trending-up");
export const Triangle = icon(TriangleIcon, "triangle");
export const TriangleAlert = icon(TriangleAlertIcon, "triangle-alert");
export const Trophy = icon(TrophyIcon, "trophy");
export const Type = icon(TypeIcon, "type");
export const Undo2 = icon(Undo02Icon, "undo-2");
export const Ungroup = icon(UngroupIcon, "ungroup");
export const User = icon(UserIcon, "user");
export const UserPlus = icon(UserPlusIcon, "user-plus");
export const Users = icon(UsersIcon, "users");
export const Utensils = icon(UtensilsIcon, "utensils");
export const Wallet = icon(Wallet01Icon, "wallet");
export const WandSparkles = icon(WandSparklesIcon, "wand-sparkles");
export const WavesHorizontal = icon(WavesIcon, "waves-horizontal");
export const Wifi = icon(Wifi01Icon, "wifi");
export const Workflow = icon(WorkflowIcon, "workflow");
export const Wrench = icon(Wrench01Icon, "wrench");
export const X = icon(XIcon, "x");
export const Zap = icon(ZapIcon, "zap");
