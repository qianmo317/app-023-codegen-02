// 口念锣鼓经解析用例 —— 时值记号 / 齐奏括号 / 休止与小节线 / 自动折行连打 / 三类报错定位
import { describe, expect, it } from 'vitest';
import { scoreFromChant } from '../src/lib/chant';
import { isBarFull, totalTicks, validateScore } from '../src/lib/grid';
import { validateHitGlyphs } from '../src/lib/glyphs';
import { computeEvents } from '../src/lib/audio';

const ok = (src: string, beatsPerBar = 4) => {
  const r = scoreFromChant(src, { beatsPerBar });
  if (!r.ok) throw new Error(`应解析成功：${r.error.message}`);
  return r.score;
};
const bad = (src: string, beatsPerBar = 4) => {
  const r = scoreFromChant(src, { beatsPerBar });
  if (r.ok) throw new Error('应解析失败');
  return r.error;
};

describe('C1-C6 时值记号与基本排谱', () => {
  it('C1 不加记号 = 整拍 4 格', () => {
    const s = ok('哐');
    expect(s.bars[0].steps[0]).toMatchObject({ beats: 4 });
  });
  it('C2 下划线 = 半拍 2 格', () => {
    const s = ok('哐_');
    expect(s.bars[0].steps[0].beats).toBe(2);
  });
  it('C3 两点 = 一拍半 6 格', () => {
    const s = ok('哐..');
    expect(s.bars[0].steps[0].beats).toBe(6);
  });
  it('C4 全角记号（＿。。｜【】〇）同样识别', () => {
    const s = ok('【哐才】。。 咚＿ 〇〇 ｜ 哐才七仓');
    expect(s.bars.length).toBe(2);
    expect(s.bars[0].steps.map((x) => x.beats)).toEqual([6, 2, 4, 4]);
    expect(validateScore(s)).toEqual([]);
  });
  it('C5 空白（空格/换行/全角空格）只作分隔，不计字', () => {
    const s = ok('哐 才\n七　仓');
    expect(s.bars[0].steps.filter((x) => x.hits.length).length).toBe(4);
  });
  it('C6 每小节铺满、拟音字与乐器对应（结构校验全过）', () => {
    const s = ok('哐才七仓 咚_咚_ [哐才].. 0 0_');
    expect(validateScore(s)).toEqual([]);
    expect(validateHitGlyphs(s)).toEqual([]);
    expect(s.bars.every(isBarFull)).toBe(true);
  });
});

describe('C7-C10 齐奏括号与休止', () => {
  it('C7 [哐才] 两个字同时响（同一步两个 hit）', () => {
    const s = ok('[哐才]');
    const st = s.bars[0].steps[0];
    expect(st.beats).toBe(4);
    expect(st.hits.map((h) => h.instrumentId).sort()).toEqual(['daluo', 'xiaoluo']);
  });
  it('C8 括号带时值：[哐才]_ = 半拍，[哐才].. = 一拍半', () => {
    expect(ok('[哐才]_').bars[0].steps[0].beats).toBe(2);
    expect(ok('[哐才]..').bars[0].steps[0].beats).toBe(6);
  });
  it('C9 休止 0 占一拍、0_ 占半拍，末尾不补重', () => {
    const s = ok('哐才七 0');
    expect(s.bars[0].steps.map((x) => x.beats)).toEqual([4, 4, 4, 4]);
    expect(s.bars[0].steps[3].rest).toBe(true);
    expect(ok('0_').bars[0].steps[0]).toMatchObject({ beats: 2, rest: true });
  });
  it('C10 技法随字带出（八=双打、台=滚奏）', () => {
    const s = ok('[八台]');
    const st = s.bars[0].steps[0];
    expect(st.hits.find((h) => h.glyph === '八')?.tech).toEqual(['flam']);
    expect(st.hits.find((h) => h.glyph === '台')?.tech).toEqual(['roll']);
  });
});

describe('C11-C15 自动折行与连打', () => {
  it('C11 一行放不下自动折到下一小节', () => {
    const s = ok('哐才七仓咚'); // 5×4=20 格 > 16
    expect(s.bars.length).toBe(2);
    expect(s.bars[1].steps[0].hits[0].glyph).toBe('咚');
  });
  it('C12 跨小节的那一下按连打处理（前段 tie + 后段空步）', () => {
    const s = ok('哐才七 仓..'); // 12 + 6：前 4 格 tie，后 2 格空步
    expect(s.bars.length).toBe(2);
    expect(s.bars[0].steps[3]).toMatchObject({ beats: 4, tie: true });
    expect(s.bars[1].steps[0]).toMatchObject({ beats: 2, hits: [] });
    expect(validateScore(s)).toEqual([]);
  });
  it('C13 末尾不足一小节补休止填满', () => {
    const s = ok('哐才');
    expect(s.bars.length).toBe(1);
    const last = s.bars[0].steps[s.bars[0].steps.length - 1];
    expect(last).toMatchObject({ beats: 8, rest: true });
    expect(isBarFull(s.bars[0])).toBe(true);
  });
  it('C14 恰好铺满不多出空小节', () => {
    expect(ok('哐才七仓').bars.length).toBe(1);
    expect(ok('哐才七仓 哐才七仓').bars.length).toBe(2);
  });
  it('C15 拍号 2/4、3/4 按各自格数折行', () => {
    expect(ok('哐才七', 2).bars.length).toBe(2); // 8 格/小节：2 字一节 + 第 3 字折行
    expect(ok('哐才七仓', 3).bars.length).toBe(2); // 12 格/小节
    expect(ok('哐才七', 2).bars[0].beatsPerBar).toBe(2);
  });
});

describe('C16-C20 小节线', () => {
  it('C16 小节线切分且每节恰好铺满', () => {
    const s = ok('哐才七仓|哐才七仓');
    expect(s.bars.length).toBe(2);
    expect(validateScore(s)).toEqual([]);
  });
  it('C17 恰好铺满后的小节线视为确认（可写可不写）', () => {
    expect(ok('哐才七仓|').bars.length).toBe(1);
    const s = ok('哐才七仓|哐才'); // 小节线后另起一小节，末尾补休止
    expect(s.bars.length).toBe(2);
    expect(s.bars[1].steps[0].hits[0].glyph).toBe('哐');
    expect(s.bars[1].steps[s.bars[1].steps.length - 1].rest).toBe(true);
    expect(validateScore(s)).toEqual([]);
  });
  it('C18 小节内格数对不上 → 报第几个字、哪一小节', () => {
    const e = bad('哐才七|哐'); // 12 格 ≠ 16 格，「|」是第 4 个字
    expect(e.kind).toBe('bar-mismatch');
    expect(e.charIndex).toBe(4);
    expect(e.barIndex).toBe(0);
    expect(e.message).toContain('第4个字');
    expect(e.message).toContain('第1小节');
    expect(e.message).toContain('格数对不上');
  });
  it('C19 连续小节线（空小节）也报格数对不上', () => {
    const e = bad('哐才七仓||');
    expect(e.kind).toBe('bar-mismatch');
    expect(e.charIndex).toBe(6);
  });
  it('C20 小节线后跨小节连打照常工作', () => {
    const s = ok('哐才七仓|哐才七 仓..');
    expect(s.bars.length).toBe(3);
    expect(s.bars[1].steps[3].tie).toBe(true);
    expect(validateScore(s)).toEqual([]);
  });
});

describe('C21-C26 三类报错：指出第几个字、哪一小节，停在那一步', () => {
  it('C21 不认识的拟音字 → 定位字序号与小节', () => {
    const e = bad('哐才喵七');
    expect(e.kind).toBe('unknown-glyph');
    expect(e.charIndex).toBe(3);
    expect(e.barIndex).toBe(0);
    expect(e.message).toContain('「喵」');
  });
  it('C22 折行后的生字报在第二小节', () => {
    const e = bad('哐才七仓 哐喵');
    expect(e.kind).toBe('unknown-glyph');
    expect(e.charIndex).toBe(6);
    expect(e.barIndex).toBe(1);
    expect(e.message).toContain('第2小节');
  });
  it('C23 括号里的生字按它自己的字序号报', () => {
    const e = bad('[哐喵]');
    expect(e.kind).toBe('unknown-glyph');
    expect(e.charIndex).toBe(3); // [ =1 哐 =2 喵 =3
  });
  it('C24 左括号没配对（念到结尾没合上）', () => {
    const e = bad('哐才 [七仓');
    expect(e.kind).toBe('unmatched-bracket');
    expect(e.charIndex).toBe(3);
    expect(e.message).toContain('方括号没配对');
  });
  it('C25 多余的右括号 / 括号套括号', () => {
    const e1 = bad('哐才]');
    expect(e1.kind).toBe('unmatched-bracket');
    expect(e1.charIndex).toBe(3);
    const e2 = bad('[哐[才]');
    expect(e2.kind).toBe('unmatched-bracket');
  });
  it('C26 出错即停：后面的内容不再解析', () => {
    const e = bad('哐喵 哐['); // 第 2 个字就错了，不再往后看
    expect(e.kind).toBe('unknown-glyph');
    expect(e.charIndex).toBe(2);
  });
});

describe('C27-C30 生成新谱，不动已有', () => {
  it('C27 每次解析生成新 id 的新谱', () => {
    const a = ok('哐才');
    const b = ok('哐才');
    expect(a.id).not.toBe(b.id);
    expect(a.title).toBe('口念锣鼓段');
  });
  it('C28 曲名与 BPM 可指定', () => {
    const r = scoreFromChant('哐才', { title: ' 师父口传一段 ', bpm: 132 });
    if (!r.ok) throw new Error('应成功');
    expect(r.score.title).toBe('师父口传一段');
    expect(r.score.bpm).toBe(132);
  });
  it('C29 空输入 → 一小节休止（不报错、结构有效）', () => {
    const s = ok('   ');
    expect(s.bars.length).toBe(1);
    expect(s.bars[0].steps[0]).toMatchObject({ beats: 16, rest: true });
    expect(validateScore(s)).toEqual([]);
  });
  it('C30 休止不能放进括号', () => {
    const e = bad('[哐0]');
    expect(e.kind).toBe('unknown-glyph');
    expect(e.charIndex).toBe(3);
  });
  it('C31 解析结果可直接展开为调度事件（连打只响一次、后段空步不发声）', () => {
    const s = ok('哐才七 仓..'); // 第 4 字跨小节：前段 tie 4 格 + 后段 2 格空步
    const evs = computeEvents(s.bars, 120, false, s.instruments, 0, totalTicks(s.bars), 0);
    const per = 60 / 120 / 4; // 每格秒数
    expect(evs.map((e) => Math.round(e.time / per))).toEqual([0, 4, 8, 12]);
  });
});
