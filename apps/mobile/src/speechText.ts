/**
 * What's been heard so far. iOS repeats a phrase as it firms up, then marks it final and starts the
 * next, so finished phrases add up and only the latest unfinished one counts.
 */
export class Heard {
  private phrases: string[] = [];
  private unfinished = "";

  add(transcript: string, final: boolean) {
    if (!final) {
      this.unfinished = transcript;
      return;
    }
    // A final result can come empty, confirming the phrase before it.
    this.phrases.push(transcript || this.unfinished);
    this.unfinished = "";
  }

  get text() {
    return [...this.phrases, this.unfinished]
      .map((phrase) => phrase.trim())
      .filter(Boolean)
      .join(" ");
  }
}
