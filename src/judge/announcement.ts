import type { JudgeSuggestion } from "./types.js";

export function createJudgeAnnouncementPublisher(
  broadcast: (suggestions: JudgeSuggestion[]) => void,
  send: (message: string) => Promise<void>,
  onNewSuggestion: (suggestion: JudgeSuggestion) => "opened" | "queued" | void = () => {},
): (suggestions: JudgeSuggestion[], newlyCreated?: JudgeSuggestion[]) => void {
  const announced = new Set<string>();
  return (suggestions, newlyCreated = suggestions) => {
    broadcast(suggestions);
    const juryStatus = new Map<string, "opened" | "queued" | void>();
    for (const suggestion of newlyCreated) {
      juryStatus.set(`${suggestion.callId}:${suggestion.contextId}`, onNewSuggestion(suggestion));
    }
    for (const suggestion of suggestions) {
      const key = `${suggestion.callId}:${suggestion.contextId}`;
      if (announced.has(key)) continue;
      announced.add(key);
      const evidence = suggestion.evidence.length > 170 ? `${suggestion.evidence.slice(0, 167)}…` : suggestion.evidence;
      const status = juryStatus.get(key);
      const nextStep = status === "opened"
        ? " The jury is open now—vote !receipts or !cap!"
        : status === "queued"
          ? " The jury is queued; vote !receipts or !cap when it opens."
          : " Reply !receipts or !cap when the jury opens.";
      void send(`🔎 Judge spotted evidence for Call #${suggestion.callId}: '${evidence}'.${nextStep}`)
        .catch(() => console.error(`Could not announce judge suggestion for Call #${suggestion.callId}.`));
    }
  };
}
