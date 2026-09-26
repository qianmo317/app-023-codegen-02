// 口念锣鼓经文本 → 可编辑 Score。
// 约定：无记号=1 拍(4格)，下划线=半拍(2格)，两点=一拍半(6格)；
// [字…]=齐奏，0=休止，| 或 ｜=小节线。不显式写小节线时按拍号自动折到下一小节。
import type { Bar, Hit, Instrument, Score, Step } from '../types';
import { barTicks } from './grid';
import { buildGlyphMap, type GlyphLookup } from './glyphs';
import { DEFAULT_INSTRUMENTS } from './factory';
import { newId } from './storage';

export type OralErrorCode = 'unknown-glyph' | 'bar-size' | 'bracket' | 'empty-input';

export class OralParseError extends Error {
  code: OralErrorCode;
  charIndex: number; // 1 起算，包含空格/记号在内的字符序号
  barIndex: number; // 1 起算；尚未进入第 1 小节时也给 1

  constructor(code: OralErrorCode, message: string, charIndex: number, barIndex: number) {
    super(message);
    this.name = 'OralParseError';
    this.code = code;
    this.charIndex = charIndex;
    this.barIndex = barIndex;
  }
}

interface OralToken {
  /** token 第一个字符（字或 [）的 0 基下标 */
  start: number;
  ticks: number;
  rest?: boolean;
  glyphs?: string[];
  invalidGlyph?: { glyph: string; pos: number };
}

export interface OralParseOptions {
  beatsPerBar?: number;
  title?: string;
  bpm?: number;
  instruments?: Instrument[];
}

const BAR_LINES = new Set(['|', '｜', '∣']);
const OPEN_BRACKETS = new Set(['[', '【', '［']);
const CLOSE_BRACKETS = new Set([']', '】', '］']);
const UNDERSCORES = new Set(['_', '＿']);
// “两点”兼容 .. 、。。、·· 以及视觉上就是上下两点的全/半角冒号。
const DOUBLE_DOTS = new Set([':', '：']);
const SINGLE_DOTS = new Set(['.', '．', '·', '・', '。']);
const WHITESPACE = new Set([' ', '\t', '\n', '\r', '　']);

function isDot(ch: string | undefined): boolean {
  return !!ch && (DOUBLE_DOTS.has(ch) || SINGLE_DOTS.has(ch));
}

function readDuration(chars: string[], i: number, tokenStart: number, barNo: number): { ticks: number; next: number } {
  let next = i;
  let ticks = 4;
  const first = chars[next];

  if (first !== undefined && UNDERSCORES.has(first)) {
    next += 1;
    ticks = 2;
    const extra = chars[next];
    if (extra !== undefined && (UNDERSCORES.has(extra) || isDot(extra))) {
      throw new OralParseError('bracket', `第 ${tokenStart + 1} 字后的时值记号不能连用，请只写一个下划线或两点`, tokenStart + 1, barNo);
    }
    return { ticks, next };
  }

  if (first !== undefined && DOUBLE_DOTS.has(first)) {
    next += 1;
    ticks = 6;
    const extra = chars[next];
    if (extra !== undefined && (UNDERSCORES.has(extra) || isDot(extra))) {
      throw new OralParseError('bracket', `第 ${tokenStart + 1} 字后的时值记号不能连用，请只写一个下划线或两点`, tokenStart + 1, barNo);
    }
    return { ticks, next };
  }

  if (first !== undefined && SINGLE_DOTS.has(first)) {
    // 允许用户把两点写散，但必须正好两个。
    const second = chars[next + 1];
    if (second !== undefined && SINGLE_DOTS.has(second)) {
      const third = chars[next + 2];
      if (third !== undefined && SINGLE_DOTS.has(third)) {
        throw new OralParseError('bracket', `第 ${tokenStart + 1} 字后只能加两点表示一拍半，不能写三个点`, tokenStart + 1, barNo);
      }
      next += 2;
      ticks = 6;
      const extra = chars[next];
      if (extra !== undefined && (UNDERSCORES.has(extra) || isDot(extra))) {
        throw new OralParseError('bracket', `第 ${tokenStart + 1} 字后的时值记号不能连用，请只写一个下划线或两点`, tokenStart + 1, barNo);
      }
      return { ticks, next };
    }
    throw new OralParseError('bracket', `第 ${tokenStart + 1} 字后只写了一个点；一拍半请写两点`, tokenStart + 1, barNo);
  }

  return { ticks, next };
}

function hitFromGlyph(glyph: string, lookup: GlyphLookup): Hit {
  return {
    instrumentId: lookup.instrumentId,
    velocity: 2,
    glyph,
    tech: lookup.tech && lookup.tech.length ? [...lookup.tech] : undefined,
  };
}

/** 只负责语法与拟音字校验；同时跟踪小节号，保证括号错误能定位到具体小节。 */
function tokenizeOralText(
  input: string,
  glyphMap: Map<string, GlyphLookup>,
  capacity: number,
): OralToken[] {
  const chars = Array.from(input);
  const tokens: OralToken[] = [];
  let i = 0;
  let bracketStart = -1;
  let bracketGlyphs: string[] = [];
  let bracketInvalid: { glyph: string; pos: number } | undefined;
  let barIndex = 0;
  let acc = 0;

  const addToken = (token: OralToken) => {
    tokens.push(token);
    if (token.ticks === 0) {
      barIndex += 1;
      acc = 0;
      return;
    }
    let remaining = token.ticks;
    while (remaining > 0) {
      if (acc === capacity) {
        barIndex += 1;
        acc = 0;
      }
      const room = capacity - acc;
      if (remaining <= room) {
        acc += remaining;
        remaining = 0;
      } else {
        remaining -= room;
        acc = capacity;
      }
    }
  };

  while (i < chars.length) {
    const ch = chars[i];
    const pos = i + 1;
    const barNo = barIndex + 1;

    if (WHITESPACE.has(ch)) {
      i += 1;
      continue;
    }
    if (BAR_LINES.has(ch)) {
      if (bracketStart >= 0) {
        throw new OralParseError('bracket', `第 ${bracketStart + 1} 字的方括号没有闭合`, bracketStart + 1, barNo);
      }
      addToken({ start: i, ticks: 0 });
      i += 1;
      continue;
    }

    if (bracketStart >= 0) {
      if (OPEN_BRACKETS.has(ch)) {
        throw new OralParseError('bracket', `第 ${pos} 字不能嵌套方括号；请先闭合第 ${bracketStart + 1} 字的方括号`, pos, barNo);
      }
      if (CLOSE_BRACKETS.has(ch)) {
        if (bracketGlyphs.length === 0 && !bracketInvalid) {
          throw new OralParseError('bracket', `第 ${bracketStart + 1} 字的方括号里没有拟音字`, bracketStart + 1, barNo);
        }
        const duration = readDuration(chars, i + 1, bracketStart, barNo);
        addToken({
          start: bracketStart,
          ticks: duration.ticks,
          ...(bracketGlyphs.length ? { glyphs: bracketGlyphs } : {}),
          ...(bracketInvalid ? { invalidGlyph: bracketInvalid } : {}),
        });
        i = duration.next;
        bracketStart = -1;
        bracketGlyphs = [];
        bracketInvalid = undefined;
        continue;
      }
      if (UNDERSCORES.has(ch) || isDot(ch)) {
        throw new OralParseError('bracket', `第 ${pos} 字的时值记号请写在右方括号后面`, pos, barNo);
      }
      if (ch === '0') {
        throw new OralParseError('bracket', `第 ${pos} 字不能把休止写进齐奏方括号`, pos, barNo);
      }
      if (!glyphMap.has(ch)) {
        if (!bracketInvalid) bracketInvalid = { glyph: ch, pos };
        i += 1;
        continue;
      }
      bracketGlyphs.push(ch);
      i += 1;
      continue;
    }

    if (CLOSE_BRACKETS.has(ch)) {
      throw new OralParseError('bracket', `第 ${pos} 字是多余的右方括号，没有对应的左方括号`, pos, barNo);
    }
    if (OPEN_BRACKETS.has(ch)) {
      bracketStart = i;
      bracketGlyphs = [];
      bracketInvalid = undefined;
      i += 1;
      continue;
    }
    if (UNDERSCORES.has(ch) || SINGLE_DOTS.has(ch) || DOUBLE_DOTS.has(ch)) {
      throw new OralParseError('bracket', `第 ${pos} 字的时值记号必须写在拟音字或右方括号后面`, pos, barNo);
    }
    if (ch === '0') {
      const duration = readDuration(chars, i + 1, i, barNo);
      addToken({ start: i, ticks: duration.ticks, rest: true });
      i = duration.next;
      continue;
    }
    if (!glyphMap.has(ch)) {
      const duration = readDuration(chars, i + 1, i, barNo);
      addToken({ start: i, ticks: duration.ticks, invalidGlyph: { glyph: ch, pos } });
      i = duration.next;
      continue;
    }

    const duration = readDuration(chars, i + 1, i, barNo);
    addToken({ start: i, ticks: duration.ticks, glyphs: [ch] });
    i = duration.next;
  }

  if (bracketStart >= 0) {
    throw new OralParseError('bracket', `第 ${bracketStart + 1} 字的方括号没有闭合`, bracketStart + 1, barIndex + 1);
  }
  return tokens;
}

function stepFromToken(
  token: OralToken,
  ticks: number,
  glyphMap: Map<string, GlyphLookup>,
  options: { tie?: boolean; continuation?: boolean } = {},
): Step {
  const tie = options.tie || undefined;
  if (token.rest) return { beats: ticks, hits: [], rest: true, tie };
  if (options.continuation) return { beats: ticks, hits: [], tie: undefined };
  const glyphs = token.glyphs ?? [];
  const seen = new Set<string>();
  const hits: Hit[] = [];
  for (const glyph of glyphs) {
    const lookup = glyphMap.get(glyph)!;
    if (seen.has(lookup.instrumentId)) continue; // 同一乐器重复念两次，仍只响一下。
    seen.add(lookup.instrumentId);
    hits.push(hitFromGlyph(glyph, lookup));
  }
  return { beats: ticks, hits, tie };
}

/**
 * 解析口念文本并生成一份全新的 Score。
 * 出错时抛出 OralParseError，调用方应停在当前输入上等待修改；本函数不写存储、不改旧谱。
 */
export function scoreFromOralText(input: string, options: OralParseOptions = {}): Score {
  const beatsPerBar = options.beatsPerBar ?? 4;
  const instruments = options.instruments ?? DEFAULT_INSTRUMENTS;
  const glyphMap = buildGlyphMap(instruments);
  const capacity = barTicks(beatsPerBar);
  const tokens = tokenizeOralText(input, glyphMap, capacity);

  if (!tokens.some((t) => t.ticks > 0)) {
    throw new OralParseError('empty-input', '请先写入要记谱的口念字串', 1, 1);
  }

  const bars: Bar[] = [];
  let current: Bar = { index: 0, beatsPerBar, steps: [] };
  let acc = 0;

  const startNewBar = () => {
    bars.push(current);
    current = { index: bars.length, beatsPerBar, steps: [] };
    acc = 0;
  };

  for (let ti = 0; ti < tokens.length; ti += 1) {
    const token = tokens[ti];
    // 显式小节线：只校验此前必须恰好排满。自动折小节由 token 跨界处理。
    if (token.ticks === 0) {
      if (acc === capacity) {
        // 满小节后的小节线只作分隔；谱末空小节最后自然丢弃，连续小节线仍报格数错误。
        startNewBar();
        continue;
      }
      if (acc !== capacity) {
        const need = (capacity - acc) / 4;
        throw new OralParseError(
          'bar-size',
          `第 ${current.index + 1} 小节格数对不上：还差 ${need} 拍，请补字或休止`,
          token.start + 1,
          current.index + 1,
        );
      }
      startNewBar();
      continue;
    }

    if (acc === capacity) startNewBar();

    if (token.invalidGlyph) {
      throw new OralParseError(
        'unknown-glyph',
        `第 ${token.invalidGlyph.pos} 字是不认识的拟音字「${token.invalidGlyph.glyph}」`,
        token.invalidGlyph.pos,
        current.index + 1,
      );
    }

    let remaining = token.ticks;
    let crossed = false;
    while (remaining > 0) {
      const room = capacity - acc;
      if (remaining <= room) {
        current.steps.push(stepFromToken(token, remaining, glyphMap, { continuation: crossed }));
        acc += remaining;
        remaining = 0;
      } else {
        // 跨小节的一下：前段保留响点并连打，空段铺到下一小节；休止跨界不连打。
        current.steps.push(stepFromToken(token, room, glyphMap, { tie: !token.rest }));
        acc += room;
        remaining -= room;
        crossed = true;
        startNewBar();
      }
    }
  }

  if (current.steps.length > 0) {
    if (acc < capacity) {
      current.steps.push({ beats: capacity - acc, hits: [], rest: true });
    }
    bars.push(current);
  }

  bars.forEach((bar, i) => {
    bar.index = i;
  });

  return {
    id: newId(),
    title: options.title?.trim() || '口念锣鼓段',
    style: '口念转谱',
    bpm: options.bpm ?? 100,
    bars,
    instruments,
    freeMeter: false,
    updatedAt: Date.now(),
  };
}

export function oralErrorText(err: unknown): string {
  if (err instanceof OralParseError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
