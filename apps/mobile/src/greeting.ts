// The new thread page's greeting for the time of day.

/** "Morning, Ryan" from 5:00 to 11:59, "Afternoon, Ryan" to 16:59, else "Evening, Ryan"; with no name, the word. */
export function greeting(hour: number, name?: string) {
  const word = hour >= 5 && hour < 12 ? "Morning" : hour >= 12 && hour < 17 ? "Afternoon" : "Evening";
  return name ? `${word}, ${name}` : word;
}
