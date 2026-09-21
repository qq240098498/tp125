const crypto = require('crypto');
const {
  load,
  save,
  MAX_SCHEME_NAME_LENGTH,
  DATE_STYLES,
  TIME_STYLES,
  SCHEME_PREF_DEFAULTS,
} = require('./store');
const { ApiError, pickText } = require('./errors');
const { convert, validateDate, validateTime } = require('./convert');

// 方案名称：去掉首尾空白后不能为空，也不能与别的方案重名（大小写不敏感）
function validateName(value, schemes, selfId) {
  const name = pickText(value);
  if (!name) throw new ApiError(400, 'SCHEME_NAME_REQUIRED', '请给换算方案起个名字', 'name');
  if (name.length > MAX_SCHEME_NAME_LENGTH) {
    throw new ApiError(400, 'SCHEME_NAME_TOO_LONG', `方案名不能超过 ${MAX_SCHEME_NAME_LENGTH} 个字符`, 'name');
  }
  const hit = schemes.find((item) => item.id !== selfId && item.name.toLowerCase() === name.toLowerCase());
  if (hit) throw new ApiError(409, 'SCHEME_NAME_DUPLICATED', `已经有名为「${hit.name}」的方案了，换个名字`, 'name');
  return name;
}

function validatePrefs(input) {
  const source = input && typeof input === 'object' ? input : {};
  if (source.dateStyle !== undefined && !DATE_STYLES.includes(source.dateStyle)) {
    throw new ApiError(400, 'SCHEME_DATE_STYLE_INVALID', '日期写法只能选短横线或中文写法', 'dateStyle');
  }
  if (source.timeStyle !== undefined && !TIME_STYLES.includes(source.timeStyle)) {
    throw new ApiError(400, 'SCHEME_TIME_STYLE_INVALID', '时刻写法只能选二十四小时制或十二小时制', 'timeStyle');
  }
  return {
    dateStyle: source.dateStyle || SCHEME_PREF_DEFAULTS.dateStyle,
    timeStyle: source.timeStyle || SCHEME_PREF_DEFAULTS.timeStyle,
  };
}

// 勾选地区清单：至少一条，编号要去重，且保存时都得是现存档案
function validateTargets(value, zones) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApiError(400, 'SCHEME_TARGETS_REQUIRED', '请至少勾选一个地区再存方案', 'targets');
  }
  const targets = [];
  value.forEach((entry) => {
    const zoneId = typeof entry === 'string' ? pickText(entry) : pickText(entry && entry.zoneId);
    if (!zoneId || targets.some((item) => item.zoneId === zoneId)) return;
    const zone = zones.find((item) => item.id === zoneId);
    if (!zone) {
      throw new ApiError(400, 'SCHEME_TARGET_NOT_FOUND', '勾选的地区里有尚未登记的档案，请刷新后重试', 'targets');
    }
    targets.push({ zoneId: zone.id, name: zone.name, displayName: zone.displayName });
  });
  if (targets.length === 0) {
    throw new ApiError(400, 'SCHEME_TARGETS_REQUIRED', '请至少勾选一个地区再存方案', 'targets');
  }
  return targets;
}

function validateSource(zoneId, zones) {
  const id = pickText(zoneId);
  if (!id) throw new ApiError(400, 'SCHEME_SOURCE_REQUIRED', '请选择来源时区', 'zoneId');
  const zone = zones.find((item) => item.id === id);
  if (!zone) throw new ApiError(400, 'SCHEME_SOURCE_NOT_FOUND', '来源时区还没有登记，请刷新后重试', 'zoneId');
  return zone;
}

// 对外视图：补出各地区当前是否还在，列表页据此标出已经失效的引用
function withView(scheme, zones) {
  const source = zones.find((item) => item.id === scheme.zoneId) || null;
  const targets = scheme.targets.map((entry) => {
    const current = zones.find((item) => item.id === entry.zoneId);
    return {
      zoneId: entry.zoneId,
      name: current ? current.name : entry.name,
      displayName: current ? current.displayName : entry.displayName,
      exists: Boolean(current),
    };
  });
  return {
    id: scheme.id,
    name: scheme.name,
    zoneId: scheme.zoneId,
    zoneName: source ? source.name : '',
    zoneDisplayName: source ? source.displayName : '',
    sourceExists: Boolean(source),
    targets,
    missingCount: targets.filter((item) => !item.exists).length,
    dateStyle: scheme.dateStyle,
    timeStyle: scheme.timeStyle,
    createdAt: scheme.createdAt,
    updatedAt: scheme.updatedAt,
  };
}

function listSchemes() {
  const data = load();
  return {
    schemes: data.schemes
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .map((item) => withView(item, data.zones)),
  };
}

function getScheme(id) {
  const data = load();
  const scheme = data.schemes.find((item) => item.id === id);
  if (!scheme) throw new ApiError(404, 'SCHEME_NOT_FOUND', '这个换算方案不存在或已被删除', '');
  return withView(scheme, data.zones);
}

function createScheme(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const name = validateName(input.name, data.schemes, '');
  const source = validateSource(input.zoneId, data.zones);
  const targets = validateTargets(input.targets, data.zones);
  const prefs = validatePrefs(input);
  const now = new Date().toISOString();
  const scheme = {
    id: crypto.randomUUID(),
    name,
    zoneId: source.id,
    targets,
    ...prefs,
    createdAt: now,
    updatedAt: now,
  };
  data.schemes.push(scheme);
  save(data);
  return withView(scheme, data.zones);
}

function updateScheme(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const scheme = data.schemes.find((item) => item.id === id);
  if (!scheme) throw new ApiError(404, 'SCHEME_NOT_FOUND', '这个换算方案不存在或已被删除', '');

  const name = validateName(input.name === undefined ? scheme.name : input.name, data.schemes, scheme.id);
  const source = validateSource(input.zoneId === undefined ? scheme.zoneId : input.zoneId, data.zones);
  const targets = input.targets === undefined
    ? scheme.targets
    : validateTargets(input.targets, data.zones);
  const prefs = validatePrefs({
    dateStyle: input.dateStyle === undefined ? scheme.dateStyle : input.dateStyle,
    timeStyle: input.timeStyle === undefined ? scheme.timeStyle : input.timeStyle,
  });

  Object.assign(scheme, { name, zoneId: source.id, targets, ...prefs });
  scheme.updatedAt = new Date().toISOString();
  save(data);
  return withView(scheme, data.zones);
}

function deleteScheme(id) {
  const data = load();
  const index = data.schemes.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'SCHEME_NOT_FOUND', '这个换算方案不存在或已被删除', '');
  const [removed] = data.schemes.splice(index, 1);
  save(data);
  return { id: removed.id, name: removed.name };
}

// 按方案重算：日期与时刻由页面当前的换算台给出（方案只记写法偏好，不锁具体时刻）。
// 勾过的地区里已经删掉的按存下的名称列进 missingZones，其余地区照常换算；
// 只有来源时区本身也被删掉时才没法算
function runScheme(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const scheme = data.schemes.find((item) => item.id === id);
  if (!scheme) throw new ApiError(404, 'SCHEME_NOT_FOUND', '这个换算方案不存在或已被删除', '');

  // 时刻不合法时沿用换算台的校验与错误码
  const date = validateDate(input.date);
  const time = validateTime(input.time);

  const source = data.zones.find((item) => item.id === scheme.zoneId);
  if (!source) {
    throw new ApiError(
      409,
      'SCHEME_SOURCE_MISSING',
      `方案的来源时区${scheme.zoneId ? `（${scheme.zoneId}）` : ''}已经被删除，没法按原方案换算，请另选来源时区后改存方案`,
      'zoneId',
    );
  }

  const targetIds = [];
  const missingZones = [];
  scheme.targets.forEach((entry) => {
    if (data.zones.some((zone) => zone.id === entry.zoneId)) {
      targetIds.push(entry.zoneId);
    } else {
      missingZones.push({ zoneId: entry.zoneId, name: entry.name, displayName: entry.displayName });
    }
  });

  // 勾选的地区全部被删掉时，没有剩余地区可算，只能连同名单一起报错
  if (targetIds.length === 0) {
    const names = missingZones.map((item) => item.name || item.zoneId).join('、');
    throw new ApiError(
      409,
      'SCHEME_TARGETS_ALL_MISSING',
      `方案勾选的地区都已被删除（${names}），没有可换算的地区了，请编辑方案重新勾选`,
      'targets',
    );
  }

  const result = convert({
    date: date.text,
    time: time.text,
    zoneId: scheme.zoneId,
    targetIds,
    dateStyle: scheme.dateStyle,
    timeStyle: scheme.timeStyle,
  });

  result.scheme = {
    id: scheme.id,
    name: scheme.name,
    storedTargetCount: scheme.targets.length,
  };
  // convert 只会因本次传入的编号报缺失，这里用方案里的快照补上名称信息
  result.missingZones = missingZones;
  return result;
}

module.exports = {
  listSchemes,
  getScheme,
  createScheme,
  updateScheme,
  deleteScheme,
  runScheme,
};
