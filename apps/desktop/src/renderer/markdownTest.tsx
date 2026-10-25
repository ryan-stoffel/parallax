// For tests that render Markdown: importing this loads Enriched Markdown's parser before the
// file's first test, after which MarkdownText draws a message in the render that makes it.
import { preloadParser } from "react-native-enriched-markdown";
import { beforeAll } from "vite-plus/test";

beforeAll(() => preloadParser());
