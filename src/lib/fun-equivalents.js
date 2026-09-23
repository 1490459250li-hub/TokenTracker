"use strict";

// fun-equivalents.js — turns a raw token count into shareable "当量" (P5, the
// viral-friendly bit). These are deliberately loose, clearly-labeled heuristics,
// not measurements: every divisor is exposed in `CONSTANTS` so the number can be
// audited or retuned. Used by `overview` for the "我靠 TokenTracker 一个月…"
// share line.

const CONSTANTS = Object.freeze({
  TOKENS_PER_CODE_LINE: 10,        // ~ code: 10 tokens per non-trivial line
  TOKENS_PER_WORD: 1.333,          // ~ 0.75 words per token (typical English prose)
  TOKENS_PER_PAGE: 667,            // a 500-word A4 page (~667 tokens)
  TOKENS_PER_BOOK: 133_000,        // a ~100k-word book
  // If every token were printed as ~4 chars stacked, 2mm tall, on a paper tape,
  // how many times around the Earth (40,075 km) would the tape reach?
  TOKENS_PER_EARTH_LAP: 5.009e9,   // 40,075,000 m / (4 chars * 0.002 m)
});

const { TOKENS_PER_CODE_LINE, TOKENS_PER_WORD, TOKENS_PER_PAGE, TOKENS_PER_BOOK, TOKENS_PER_EARTH_LAP } = CONSTANTS;

// Returns rounded "当量" plus the raw constants for transparency. Accepts a
// total token count (input+output+cached+cache-creation) — the number people
// actually see on a bill — and the output-only tokens for the "写了多少" items,
// since output is what the model actually produced.
function tokensToEquivalents(totalTokens, outputTokens) {
  const total = Math.max(0, Number(totalTokens) || 0);
  const out = Math.max(0, Number(outputTokens) || 0);
  const round = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);
  return {
    code_lines: round(out / TOKENS_PER_CODE_LINE),
    words_written: round(out / TOKENS_PER_WORD),
    pages: round(total / TOKENS_PER_PAGE),
    books: round(total / TOKENS_PER_BOOK),
    earth_laps: round(total / TOKENS_PER_EARTH_LAP),
    _constants: CONSTANTS,
  };
}

// A single punchy line for sharing. Chooses the most relatable unit automatically.
function headlineEquivalent(e) {
  if (e.code_lines >= 1) return `写了约 ${fmt(e.code_lines)} 行代码`;
  if (e.words_written >= 1) return `写了约 ${fmt(e.words_written)} 个单词`;
  if (e.pages >= 1) return `打满约 ${fmt(e.pages)} 页 A4`;
  if (e.books >= 0.5) return `相当于约 ${fmt(e.books)} 本书的信息量`;
  return `信息量约 ${fmt(e.earth_laps)} 圈地球`;
}

function fmt(n) {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : `${n}`;
}

module.exports = { tokensToEquivalents, headlineEquivalent, CONSTANTS, fmt };
