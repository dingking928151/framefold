// 关卡数据加载与运行时边界校验。
const ID_RE = /^[a-z0-9-]+$/;

function isInt(n) {
  return Number.isSafeInteger(n);
}

function checkRect(r, w, h, where) {
  if (!r || typeof r !== 'object') throw new Error(`${where}:缺少取景框`);
  for (const k of ['x', 'y', 'w', 'h']) {
    if (!isInt(r[k]) || r[k] < 0) throw new Error(`${where}:${k} 必须为非负整数`);
  }
  if (r.w < 1 || r.h < 1) throw new Error(`${where}:取景框尺寸无效`);
  if (r.x + r.w > w || r.y + r.h > h) throw new Error(`${where}:取景框越界`);
}

export function validateScenes(data) {
  if (!data || data.v !== 1 || !Array.isArray(data.scenes) || data.scenes.length === 0) {
    throw new Error('scenes.json 结构无效');
  }
  const ids = new Set();
  for (const s of data.scenes) {
    if (!ID_RE.test(s.id || '')) throw new Error('场景 id 无效');
    if (ids.has(s.id)) throw new Error(`场景 id 重复:${s.id}`);
    ids.add(s.id);
    if (typeof s.image !== 'string' || !s.image) throw new Error(`${s.id}:缺少 image`);
    if (!isInt(s.width) || !isInt(s.height) || s.width < 1 || s.height < 1) {
      throw new Error(`${s.id}:画布尺寸无效`);
    }
    checkRect(s.crop, s.width, s.height, s.id);
    if (typeof s.question !== 'string' || !s.question) throw new Error(`${s.id}:缺少 question`);
    if (!Array.isArray(s.choices) || s.choices.length < 2 || s.choices.some((c) => typeof c !== 'string' || !c)) {
      throw new Error(`${s.id}:choices 至少两个非空标题`);
    }
    if (!isInt(s.answer) || s.answer < 0 || s.answer >= s.choices.length) {
      throw new Error(`${s.id}:answer 无效`);
    }
    if (typeof s.reveal !== 'string' || !s.reveal) throw new Error(`${s.id}:缺少 reveal`);
    if (Array.isArray(s.clues)) {
      for (const c of s.clues) {
        if (!isInt(c.x) || !isInt(c.y) || c.x < 0 || c.y < 0 || c.x > s.width || c.y > s.height) {
          throw new Error(`${s.id}:线索坐标无效`);
        }
        if (typeof c.label !== 'string' || typeof c.detail !== 'string') {
          throw new Error(`${s.id}:线索文案无效`);
        }
        if (c.focus) checkRect(c.focus, s.width, s.height, `${s.id} 线索`);
      }
    }
  }
  return data;
}

export async function loadScenes() {
  const res = await fetch(new URL('content/scenes.json', document.baseURI), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`关卡数据加载失败(${res.status})`);
  return validateScenes(await res.json());
}