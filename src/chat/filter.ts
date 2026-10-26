// shortcut: this starter English profanity list is intentionally small; expand it to match the channel's preferred blocklist.
const BLOCKED_WORDS = [
  "asshole", "assholes", "bastard", "bastards", "bitch", "bitches", "cunt", "cunts",
  "fuck", "fucked", "fucker", "fuckers", "fucking", "shit", "shits", "shitty",
];

export function containsBlockedWord(text: string): boolean {
  const normalized = text.normalize("NFKC");
  return BLOCKED_WORDS.some((word) => {
    const pattern = [...word].map((character) => character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^\\p{L}\\p{N}]*");
    return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, "iu").test(normalized);
  });
}
