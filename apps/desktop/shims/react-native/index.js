// What Enriched Markdown's web build imports from React Native: Platform, which its style defaults
// read, and processColor, which it calls only off the web, passing colors through as written.
export const Platform = { OS: "web", select: (choices) => choices.web ?? choices.default };
export const processColor = (color) => color;
