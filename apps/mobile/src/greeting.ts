// The new thread page's greeting for the time of day.
import { t } from "i18next";

/** "Morning, Ryan" from 5:00 to 11:59, "Afternoon, Ryan" to 16:59, else "Evening, Ryan"; with no name, the word. */
export function greeting(hour: number, name?: string) {
  if (hour >= 5 && hour < 12) return name ? t("Morning, {{name}}", { name }) : t("Morning");
  if (hour >= 12 && hour < 17) return name ? t("Afternoon, {{name}}", { name }) : t("Afternoon");
  return name ? t("Evening, {{name}}", { name }) : t("Evening");
}
