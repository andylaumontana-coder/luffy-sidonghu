import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRecommendedPersonaIds } from '../src/personas.ts';

test('parses standard recommendation block', () => {
  const sample = `【议题锁定】
**核心张力：** A vs B
**推荐幕僚：** 乔布斯（热爱）、Naval（自由）、王阳明、稻盛和夫`;
  assert.deepEqual(
    extractRecommendedPersonaIds(sample),
    ['jobs', 'naval', 'inamori', 'yangming'],
  );
});

test('returns empty when no recommendation block matches anything', () => {
  assert.deepEqual(extractRecommendedPersonaIds('【议题锁定】啥都没说'), []);
});

test('only counts names inside the recommendation scope', () => {
  const text = `闲聊提到 乔布斯、Naval、王阳明、马斯克、芒格。

【议题锁定】
**推荐幕僚：** 乔布斯、芒格`;
  assert.deepEqual(extractRecommendedPersonaIds(text), ['jobs', 'munger']);
});

test('handles English aliases', () => {
  const text = `推荐幕僚：Paul Graham, Musk, Taleb`;
  assert.deepEqual(extractRecommendedPersonaIds(text), ['pg', 'musk', 'taleb']);
});

test('falls back to whole text when no 推荐幕僚 marker', () => {
  const text = `给案主推荐 老子 与 张一鸣`;
  assert.deepEqual(extractRecommendedPersonaIds(text), ['zhang', 'laozi']);
});
