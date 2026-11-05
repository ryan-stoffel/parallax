import { Platform } from "react-native";

/** What the app calls this phone, to its user and to the computers it signs in to. */
export const PHONE = Platform.OS === "ios" ? "iPhone" : "Android phone";
