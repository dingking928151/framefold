// 裁框挑战分享协议 v1 —— 纯函数,无 DOM 依赖,可在 Node 中直接回归测试。
export const MIN_CROP = 32;
export const MAX_TITLE = 48;

const INT_RE = /^(0|[1-9]\d*)$/;
const FIELDS = ['v', 's', 'x', 'y', 'w', 'h', 't'];

export function countCodePoints(str) {
  return Array.from(str).length;
}

export function clampTitle(str) {
  // 与 hasControlChars 同口径(C0 + DEL):先清理再按码点截断
  return Array.from(str)
    .filter((ch) => {
      const cp = ch.codePointAt(0);
      return cp >= 32 && cp !== 127;
    })
    .slice(0, MAX_TITLE)
    .join('');
}

function hasControlChars(str) {
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp < 32 || cp === 127) return true;
  }
  return false;
}

export function encodeChallenge(c) {
  const p = new URLSearchParams();
  p.set('v', '1');
  p.set('s', c.s);
  p.set('x', String(c.x));
  p.set('y', String(c.y));
  p.set('w', String(c.w));
  p.set('h', String(c.h));
  p.set('t', c.t);
  return p.toString();
}

export function decodeChallenge(fragment, scenes) {
  const fail = (reason) => ({ ok: false, reason });
  if (typeof fragment !== 'string' || fragment.length === 0) return fail('空片段');
  let p;
  try {
    p = new URLSearchParams(fragment);
  } catch {
    return fail('片段无法解析');
  }
  const keys = [...p.keys()];
  if (new Set(keys).size !== keys.length) return fail('参数重复');
  for (const k of keys) {
    if (!FIELDS.includes(k)) return fail('未知参数');
  }
  if (p.get('v') !== '1') return fail('协议版本不符');
  const scene = scenes.find((s) => s.id === p.get('s'));
  if (!scene) return fail('场景不存在');
  const nums = {};
  for (const k of ['x', 'y', 'w', 'h']) {
    const raw = p.get(k);
    if (raw === null || !INT_RE.test(raw)) return fail('坐标必须为整数');
    nums[k] = Number(raw);
    if (!Number.isSafeInteger(nums[k])) return fail('坐标超出范围');
  }
  const { x, y, w, h } = nums;
  if (w < MIN_CROP || h < MIN_CROP) return fail('取景框过小');
  if (x + w > scene.width || y + h > scene.height) return fail('取景框越界');
  const t = p.get('t');
  if (t === null) return fail('缺少标题');
  const len = countCodePoints(t);
  if (len < 1 || len > MAX_TITLE) return fail('标题长度须为 1–48 个字符');
  if (hasControlChars(t)) return fail('标题含控制字符');
  return { ok: true, scene, challenge: { s: scene.id, x, y, w, h, t } };
}

export function buildShareURL(href, challenge) {
  return href.split('#')[0] + '#' + encodeChallenge(challenge);
}