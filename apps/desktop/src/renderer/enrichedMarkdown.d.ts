// What patches/react-native-enriched-markdown@*.patch adds to the package's web entry, which its
// types (written for React Native) don't declare.
import type { ReactNode } from "react";
import "react-native-enriched-markdown";

declare module "react-native-enriched-markdown" {
  /** Loads the Markdown parser, after which a message is parsed in the render that draws it. */
  export function preloadParser(): Promise<void>;
}

declare module "react-native-enriched-markdown/lib/typescript/src/types/MarkdownTextProps" {
  interface EnrichedMarkdownTextProps {
    /** What a link draws, given its URL and its own text, in place of that text. */
    renderLinkContent?: (link: { url: string; children: ReactNode }) => ReactNode;
  }
}
