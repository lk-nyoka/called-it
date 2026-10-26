import { z } from "zod";
import type { ContextSource } from "../core/context.js";

export type JudgeCall = { id: number; text: string; createdAt: number; viewerId?: string };
export type JudgeContext = { t: number; source: ContextSource; text: string; callId?: number; chatters?: number; chatterId?: string; bot?: boolean };
export type JudgeInput = { calls: JudgeCall[]; context: JudgeContext[] };
export type JudgeCandidate = { callId: number; confidence: number; evidence: string };
export type JudgeSuggestion = JudgeCandidate & { contextId: number; contextTimestamp: number };
export type JudgeOutput = { candidates: JudgeCandidate[] };

export const JudgeCandidateSchema = z.object({
  callId: z.number().int().positive(),
  confidence: z.number().min(0).max(1),
  evidence: z.string().min(1).max(500),
}).strict();
export const JudgeOutputSchema = z.object({ candidates: z.array(z.unknown()) }).strict();

export function parseJudgeOutput(value: unknown): JudgeOutput {
  const envelope = JudgeOutputSchema.parse(value);
  return {
    candidates: envelope.candidates.flatMap((candidate) => {
      const parsed = JudgeCandidateSchema.safeParse(candidate);
      return parsed.success ? [parsed.data] : [];
    }),
  };
}

export type JudgeProvider = {
  evaluate(input: JudgeInput): Promise<JudgeOutput>;
  scoreBoldness(text: string): Promise<number>;
};
