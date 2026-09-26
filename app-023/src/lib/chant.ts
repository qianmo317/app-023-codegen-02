// 口念锣鼓经 → 谱面解析器（纯函数，不碰存储与 DOM）
// 语法（师父口念的字串直接记下）：
//   字      占一拍（4 格）         字_     占半拍（2 格）
//   字..    占一拍半（6 格）       [字1字2] 几个字同时响（齐奏，] 后可带 _ 或 ..）
//   0       休止（同样可带 _ / ..）  |      小节分隔线
// 排谱规则：按每小节格数顺次落格，一行放不下自动折到下一小节；
// 跨小节的那一下按连打处理（前段 tie + 后段空步）；末尾不足补休止填满。
// 写了小节线的小节必须恰好铺满，否则报「格数对不上」。
import { TICKS_PER_BEAT, type Bar, type Instrument, type Score, type Step } from '../types';
import { barTicks } from './grid';
import { lookupGlyph } from './glyphs';
import { newId } from './storage';
import { DEFAULT_INSTRUMENTS } from './factory';

export type ChantErrorKind = 'unknown-glyph' | 'bar-mismatch' | 'unmatched-bracket';

export interface ChantError {
  kind: ChantErrorKind;
  charIndex: number; // 第几个字（从 1 数起，空白不计；括号/小节线也算一个字位）
  barIndex: number; // 出错时所在小节（从 0 数起）
  message: string;
}

export type ChantResult = { ok: true; score: Score } | { ok: false; error: ChantError };

export interface ChantOptions {
  title?: string;
  beatsPerBar?: number; // 每小节拍数（2/3/4），默认 4
  bpm?: number;
  instruments?: Instrument[];
}

const HALF = TICKS_PER_BEAT / 2; // 半拍 = 2 格
const DOTTED = TICKS_PER_BEAT + HALF; // 一拍半 = 6 格

const isSpace = (ch: string) => /\s/.test(ch);
const isBarline = (ch: string) => ch === '|' || ch === '｜';
const isOpenB = (ch: string) => ch === '[' || ch === '【';
const isCloseB = (ch: string) => ch === ']' || ch === '】';
const isRest = (ch: string) => ch === '0' || ch === '〇';

/** 口念字串 → 新谱。任何错误都停在出错的那一步（返回第一个错误），不产生谱。 */
export function scoreFromChant(src: string, opts: ChantOptions = {}): ChantResult {
  const beatsPerBar = opts.beatsPerBar ?? 4;
  const instruments = opts.instruments ?? DEFAULT_INSTRUMENTS;
  const barT = barTicks(beatsPerBar);

  const bars: Bar[] = [{ index: 0, beatsPerBar, steps: [] }];
  let acc = 0; // 当前小节已排格数
  let ord = 0; // 字序号（第几个字）
  let lastTok: 'start' | 'item' | 'barline' = 'start';
  let i = 0;

  const mkError = (kind: ChantErrorKind, charIndex: number, detail: string): ChantError => ({
    kind,
    charIndex,
    barIndex: bars.length - 1,
    message: `第${charIndex}个字${detail}（第${bars.length}小节）`,
  });
  const fail = (kind: ChantErrorKind, charIndex: number, detail: string): ChantResult => ({
    ok: false,
    error: mkError(kind, charIndex, detail),
  });

  /** 读字后的时值记号：_ / ＿ = 半拍；.. / 。。 = 一拍半；都没有 = 整拍 */
  const readDuration = (): number => {
    const ch = src[i];
    if (ch === '_' || ch === '＿') {
      i += 1;
      return HALF;
    }
    const two = src.slice(i, i + 2);
    if (two === '..' || two === '。。') {
      i += 2;
      return DOTTED;
    }
    return TICKS_PER_BEAT;
  };

  /** 一个条目落格：跨小节自动切分（前段 tie 连打 + 后段空步） */
  const place = (step: Step) => {
    let s = step;
    if (acc + s.beats > barT) {
      const remain = barT - acc;
      if (remain > 0) {
        bars[bars.length - 1].steps.push({ ...s, beats: remain, tie: true });
        s = { ...s, beats: s.beats - remain, hits: [] };
      }
      bars.push({ index: bars.length, beatsPerBar, steps: [] });
      acc = 0;
    }
    bars[bars.length - 1].steps.push(s);
    acc += s.beats;
    if (acc === barT) {
      bars.push({ index: bars.length, beatsPerBar, steps: [] });
      acc = 0;
    }
  };

  /** 拟音字组 → Step；有不认识的字返回错误 */
  const stepFromGlyphs = (glyphs: { ch: string; ord: number }[], ticks: number): Step | ChantError => {
    const hits: Step['hits'] = [];
    for (const g of glyphs) {
      const lu = lookupGlyph(g.ch, instruments);
      if (!lu) return mkError('unknown-glyph', g.ord, `「${g.ch}」：不认识的拟音字`);
      hits.push({ instrumentId: lu.instrumentId, velocity: 2, glyph: g.ch, tech: lu.tech ? [...lu.tech] : undefined });
    }
    return { beats: ticks, hits };
  };

  while (i < src.length) {
    const ch = src[i];
    if (isSpace(ch)) {
      i += 1;
      continue;
    }
    if (isBarline(ch)) {
      ord += 1;
      i += 1;
      if (acc === 0) {
        // 上一条目恰好铺满时小节线是确认（跳过）；开头/连续小节线是空小节错误
        if (lastTok === 'item') {
          lastTok = 'barline';
          continue;
        }
        return fail('bar-mismatch', ord, `「|」：小节线前是空小节，格数对不上（应为${barT}格）`);
      }
      if (acc !== barT) {
        return fail('bar-mismatch', ord, `「|」：这一小节只排了${acc}格，格数对不上（应为${barT}格）`);
      }
      bars.push({ index: bars.length, beatsPerBar, steps: [] });
      acc = 0;
      lastTok = 'barline';
      continue;
    }
    if (isCloseB(ch)) {
      ord += 1;
      i += 1;
      return fail('unmatched-bracket', ord, `「]」：没有对应的「[」，方括号没配对`);
    }
    if (isOpenB(ch)) {
      const openOrd = ++ord;
      i += 1;
      const glyphs: { ch: string; ord: number }[] = [];
      let closed = false;
      while (i < src.length) {
        const c = src[i];
        if (isCloseB(c)) {
          closed = true;
          i += 1;
          break;
        }
        if (isSpace(c)) {
          i += 1;
          continue;
        }
        if (isOpenB(c)) {
          ord += 1;
          return fail('unmatched-bracket', ord, `「[」：括号里不能再开括号，方括号没配对`);
        }
        if (isRest(c)) {
          ord += 1;
          return fail('unknown-glyph', ord, `「0」：休止不能放进括号，括号里只写同时响的拟音字`);
        }
        ord += 1;
        glyphs.push({ ch: c, ord });
        i += 1;
      }
      if (!closed) return fail('unmatched-bracket', openOrd, `「[」：一直念到结尾也没等到「]」，方括号没配对`);
      if (glyphs.length === 0)
        return fail('unmatched-bracket', openOrd, `「[]」：括号里至少要有一个拟音字`);
      const ticks = readDuration();
      const step = stepFromGlyphs(glyphs, ticks);
      if (!('beats' in step)) return { ok: false, error: step };
      place(step);
      lastTok = 'item';
      continue;
    }
    if (isRest(ch)) {
      ord += 1;
      i += 1;
      place({ beats: readDuration(), hits: [], rest: true });
      lastTok = 'item';
      continue;
    }
    // 普通拟音字
    ord += 1;
    i += 1;
    const step = stepFromGlyphs([{ ch, ord }], readDuration());
    if (!('beats' in step)) return { ok: false, error: step };
    place(step);
    lastTok = 'item';
  }

  // 末尾：不足一小节补休止填满；末尾空小节（恰好铺满或结尾是小节线）丢弃
  const last = bars[bars.length - 1];
  if (acc > 0) last.steps.push({ beats: barT - acc, hits: [], rest: true });
  else if (bars.length > 1 && last.steps.length === 0) bars.pop();
  else if (last.steps.length === 0) last.steps.push({ beats: barT, hits: [], rest: true }); // 全空输入 → 一小节休止
  bars.forEach((b, bi) => (b.index = bi));

  return {
    ok: true,
    score: {
      id: newId(),
      title: opts.title?.trim() || '口念锣鼓段',
      bpm: opts.bpm ?? 100,
      bars,
      instruments,
      freeMeter: false,
      updatedAt: Date.now(),
    },
  };
}
