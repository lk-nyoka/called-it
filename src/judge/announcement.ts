import type { JudgeSuggestion } from "./types.js";

export function createJudgeAnnouncementPublisher(
  broadcast: (suggestions: JudgeSuggestion[]) => void,
  send: (message: string) => Promise<void>,
  onNewSuggestion: (suggestion: JudgeSuggestion) => void = () => {},
): (suggestions: JudgeSuggestion[], newlyCreated?: JudgeSuggestion[]) => void {
  const announced = new Set<string>();
  return (suggestions, newlyCreated = suggestions) => {
    broadcast(suggestions);
    for (const suggestion of newlyCreated) onNewSuggestion(suggestion);
    for (const suggestion of suggestions) {
      const key = `${suggestion.callId}:${suggestion.contextId}`;
      if (announced.has(key)) continue;
      announced.add(key);
      const evidence = suggestion.evidence.length > 170 ? `${suggestion.evidence.slice(0, 167)}…` : suggestion.evidence;
      void send(`🔎 Judge spotted evidence for Call #${suggestion.callId}: '${evidence}'. Reply !receipts or !cap when the jury opens.`)
        .catch(() => console.error(`Could not announce judge suggestion for Call #${suggestion.callId}.`));
    }
  };
}
