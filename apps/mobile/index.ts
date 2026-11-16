import "./src/polyfill";
// Before the app, since a closed app gets its pushes only through this task.
import "./src/androidPush";

import { registerRootComponent } from "expo";

import App from "./src/App";

registerRootComponent(App);
