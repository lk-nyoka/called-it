import { KeywordJudge } from "./keyword.js";
import { OpenAIJudge } from "./openai.js";
import type { JudgeInput, JudgeOutput, JudgeProvider } from "./types.js";

class FallbackJudge implements JudgeProvider {
  private warned = false;

  constructor(private readonly primary: JudgeProvider, private readonly fallback: KeywordJudge) {}

  async evaluate(input: JudgeInput): Promise<JudgeOutput> {
    try { return await this.primary.evaluate(input); }
    catch (error) {
      this.warn(error);
      return this.fallback.evaluate(input);
    }
  }

  async scoreBoldness(text: string): Promise<number> {
    try { return await this.primary.scoreBoldness(text); }
    catch (error) {
      this.warn(error);
      return this.fallback.scoreBoldness(text);
    }
  }

  private warn(error: unknown): void {
    if (this.warned) return;
    this.warned = true;
    const reason = error instanceof Error ? error.message : "unknown error";
    console.warn(`Called It is falling back to the free keyword judge: ${reason}`);
  }
}

export function createJudgeProvider(mode = "keyword", apiKey = ""): JudgeProvider {
  const keyword = new KeywordJudge();
  if (mode.toLowerCase() !== "openai") return keyword;
  if (!apiKey.trim()) {
    console.warn("JUDGE_PROVIDER=openai but OPENAI_API_KEY is empty; using the free keyword judge.");
    return keyword;
  }
  return new FallbackJudge(new OpenAIJudge(apiKey.trim()), keyword);
}

const activeProvider = createJudgeProvider(process.env.JUDGE_PROVIDER, process.env.OPENAI_API_KEY);

export function scoreCallBoldness(text: string): Promise<number> {
  return activeProvider.scoreBoldness(text);
}

export { activeProvider };
