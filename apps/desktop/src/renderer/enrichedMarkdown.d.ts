// What patches/react-native-enriched-markdown@*.patch adds to the package's web entry, which its
// types (written for React Native) don't declare.
import "react-native-enriched-markdown";

declare module "react-native-enriched-markdown" {
  /** Loads the Markdown parser, after which a message is parsed in the render that draws it. */
  export function preloadParser(): Promise<void>;
}
