import { describe, expect, it } from 'vitest';
import { isBarFull, validateScore } from '../src/lib/grid';
import { validateHitGlyphs } from '../src/lib/glyphs';
import { OralParseError, scoreFromOralText } from '../src/lib/oral';

describe('口念锣鼓经解析', () => {
  it('按拍号排入小节，末尾自动补休止', () => {
    const score = scoreFromOralText('哐 才 七 台 | 咚_ 咚_ 才 哐', { beatsPerBar: 4 });
    expect(score.bars).toHaveLength(2);
    expect(score.bars.map((b) => b.steps.map((s) => s.beats))).toEqual([
      [4, 4, 4, 4],
      [2, 2, 4, 4, 4],
    ]);
    expect(score.bars[1].steps.at(-1)?.rest).toBe(true);
    expect(validateScore(score)).toEqual([]);
  });

  it('下划线=半拍，两点/冒号=一拍半', () => {
    const score = scoreFromOralText('哐_ 才: 七.. 台', { beatsPerBar: 2 });
    expect(score.bars[0].steps.map((s) => s.beats)).toEqual([2, 6]);
    expect(score.bars[1].steps.map((s) => s.beats)).toEqual([6, 2]);
    expect(isBarFull(score.bars[0])).toBe(true);
    expect(isBarFull(score.bars[1])).toBe(true);
  });

  it('一行放不下时跨小节，跨小节那一下按连打处理', () => {
    const score = scoreFromOralText('哐 哐 哐 咚_ 咚:', { beatsPerBar: 4 });
    expect(score.bars).toHaveLength(2);
    expect(score.bars[0].steps.map((s) => s.beats)).toEqual([4, 4, 4, 2, 2]);
    expect(score.bars[0].steps.at(-1)?.tie).toBe(true);
    expect(score.bars[0].steps.at(-1)?.hits[0]?.glyph).toBe('咚');
    expect(score.bars[1].steps[0].hits).toEqual([]);
    expect(score.bars[1].steps[0].beats).toBe(4);
    expect(score.bars[1].steps.at(-1)?.rest).toBe(true);
    expect(validateScore(score)).toEqual([]);
  });

  it('方括号里的多个字落在同一步，形成齐奏', () => {
    const score = scoreFromOralText('[哐才七] 咚', { beatsPerBar: 1 });
    const step = score.bars[0].steps[0];
    expect(step.beats).toBe(4);
    expect(step.hits.map((h) => h.instrumentId).sort()).toEqual(['bo', 'daluo', 'xiaoluo']);
    expect(validateHitGlyphs(score)).toEqual([]);
  });

  it('休止参与时值并可带半拍记号', () => {
    const score = scoreFromOralText('哐 0_ 才_ 七', { beatsPerBar: 2 });
    expect(score.bars[0].steps.map((s) => ({ beats: s.beats, rest: !!s.rest }))).toEqual([
      { beats: 4, rest: false },
      { beats: 2, rest: true },
      { beats: 2, rest: false },
    ]);
  });

  it('允许谱末多写一条小节线', () => {
    const score = scoreFromOralText('哐 才 七 台 |', { beatsPerBar: 4 });
    expect(score.bars).toHaveLength(1);
    expect(validateScore(score)).toEqual([]);
  });

  it('未知拟音字报告字符序号和小节，停止且不返回谱', () => {
    expect.assertions(4);
    try {
      scoreFromOralText('哐哐哐哐|哆', { beatsPerBar: 4 });
    } catch (err) {
      expect(err).toBeInstanceOf(OralParseError);
      expect(err).toMatchObject({ code: 'unknown-glyph', charIndex: 6, barIndex: 2 });
      expect((err as Error).message).toContain('哆');
    }
    expect(() => scoreFromOralText('哐哐哐哐|哆', { beatsPerBar: 4 })).toThrow(OralParseError);
  });

  it('显式小节格数对不上时指出小节线位置和小节', () => {
    try {
      scoreFromOralText('哐 才 |', { beatsPerBar: 4 });
      throw new Error('不应解析成功');
    } catch (err) {
      expect(err).toMatchObject({ code: 'bar-size', charIndex: 5, barIndex: 1 });
      expect((err as Error).message).toContain('第 1 小节格数对不上');
    }
  });

  it('连续小节线视为空小节格数对不上', () => {
    expect(() => scoreFromOralText('哐哐哐哐||', { beatsPerBar: 4 })).toThrow(
      expect.objectContaining({ code: 'bar-size', charIndex: 6, barIndex: 2 }),
    );
  });

  it('方括号未闭合时指出第几个字、哪一小节', () => {
    expect(() => scoreFromOralText('哐哐哐哐|[哐 才', { beatsPerBar: 4 })).toThrow(
      expect.objectContaining({ code: 'bracket', charIndex: 6, barIndex: 2 }),
    );
  });

  it('多余的右方括号也作为括号配对错误', () => {
    expect(() => scoreFromOralText('哐]', { beatsPerBar: 4 })).toThrow(
      expect.objectContaining({ code: 'bracket', charIndex: 2, barIndex: 1 }),
    );
  });

  it('括号里出现休止直接报括号错误', () => {
    expect(() => scoreFromOralText('[哐0]', { beatsPerBar: 4 })).toThrow(
      expect.objectContaining({ code: 'bracket', charIndex: 3, barIndex: 1 }),
    );
  });
});
