// What the desktop renderer imports that the phone never runs. The shared hooks' type-only imports
// reach these files (threads.ts → models.ts → providers.ts), so tsc reads them; Metro doesn't.
declare module "lucide-react" {
  import type { FC, SVGProps } from "react";
  type Icon = FC<SVGProps<SVGSVGElement>>;
  export const ArrowUpRight: Icon, Bot: Icon, CircleAlert: Icon, CircleCheck: Icon, Cpu: Icon;
  export const Info: Icon, MessageCircleQuestion: Icon, X: Icon;
}
