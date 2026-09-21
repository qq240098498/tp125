// 换算方案：把一组换算设置（选中的地区、来源时区、日期与时刻的写法偏好）存成名字，
// 之后按方案重算。方案只记引用与快照，重算时一律按档案里的最新数据换算
const crypto = require('crypto');
const { load, save, MAX_PRESET_NAME_LENGTH, DATE_FORMATS, TIME_FORMATS } = require('./store');
const { ApiError, pickText } = require('./errors');
const { computeConversion, validateDate, validateTime } = require('./convert');
const { offsetText } = require('./zones');

function validatePresetName(value, data, selfId) {
  const name = pickText(value);
  if (!name) throw new ApiError(400, 'PRESET_NAME_REQUIRED', '请给方案取个名字', 'presetName');
  if (name.length > MAX_PRESET_NAME_LENGTH) {
    throw new ApiError(400, 'PRESET_NAME_TOO_LONG', `方案名不能超过 ${MAX_PRESET_NAME_LENGTH} 个字符`, 'presetName');
  }
  const hit = data.presets.find((item) => item.id !== selfId && item.name.toLowerCase() === name.toLowerCase());
  if (hit) throw new ApiError(409, 'PRESET_NAME_DUPLICATED', `方案名「${hit.name}」已经用过了，换一个名字`, 'presetName');
  return name;
}

// 存方案时引用的地区必须都还在档案里；之后被删是重算时要处理的事
function validateZoneIds(value, data) {
  const raw = Array.isArray(value) ? value : [];
  const ids = [...new Set(raw.filter((id) => typeof id === 'string' && id))];
  if (!ids.length) {
    throw new ApiError(400, 'PRESET_ZONES_REQUIRED', '方案至少要包含一个地区', 'presetZones');
  }
  const byId = new Map(data.zones.map((zone) => [zone.id, zone]));
  if (ids.some((id) => !byId.has(id))) {
    throw new ApiError(400, 'PRESET_ZONE_UNKNOWN', '选中的地区里有没登记过的，请刷新列表后重试', 'presetZones');
  }
  return ids.map((id) => {
    const zone = byId.get(id);
    return { zoneId: zone.id, name: zone.name, displayName: zone.displayName };
  });
}

function validateSourceZoneId(value, data) {
  const sourceZoneId = pickText(value);
  if (!sourceZoneId) throw new ApiError(400, 'PRESET_SOURCE_REQUIRED', '方案要指定来源时区', 'presetSource');
  const source = data.zones.find((zone) => zone.id === sourceZoneId);
  if (!source) throw new ApiError(400, 'PRESET_SOURCE_UNKNOWN', '来源时区没有登记过，请刷新列表后重试', 'presetSource');
  return source;
}

function validateDateFormat(value) {
  if (!DATE_FORMATS.includes(value)) {
    throw new ApiError(400, 'PRESET_DATE_FORMAT_INVALID', '日期写法只支持年-月-日、中文写法、日/月/年与月/日/年', 'presetDateFormat');
  }
  return value;
}

function validateTimeFormat(value) {
  if (!TIME_FORMATS.includes(value)) {
    throw new ApiError(400, 'PRESET_TIME_FORMAT_INVALID', '时刻写法只支持 24 小时制与 12 小时制', 'presetTimeFormat');
  }
  return value;
}

function presentPreset(preset) {
  return {
    id: preset.id,
    name: preset.name,
    zones: preset.zones.map((ref) => ({ ...ref })),
    zoneCount: preset.zones.length,
    sourceZoneId: preset.sourceZoneId,
    sourceName: preset.sourceName,
    sourceDisplayName: preset.sourceDisplayName,
    dateFormat: preset.dateFormat,
    timeFormat: preset.timeFormat,
    createdAt: preset.createdAt,
    updatedAt: preset.updatedAt,
  };
}

// 方案清单：按保存先后排列
function listPresets() {
  const data = load();
  const presets = data.presets.slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return { presets: presets.map(presentPreset), total: presets.length };
}

function getPreset(id) {
  const data = load();
  const found = data.presets.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'PRESET_NOT_FOUND', '这个换算方案不存在或已被删除', '');
  return presentPreset(found);
}

function createPreset(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const checked = {
    name: validatePresetName(input.name, data, ''),
    zones: validateZoneIds(input.zoneIds, data),
    dateFormat: validateDateFormat(input.dateFormat),
    timeFormat: validateTimeFormat(input.timeFormat),
  };
  const source = validateSourceZoneId(input.sourceZoneId, data);
  const now = new Date().toISOString();
  const preset = {
    id: crypto.randomUUID(),
    ...checked,
    sourceZoneId: source.id,
    sourceName: source.name,
    sourceDisplayName: source.displayName,
    createdAt: now,
    updatedAt: now,
  };
  data.presets.push(preset);
  save(data);
  return presentPreset(preset);
}

// 修改方案：只校验这次带上的字段，没带的保持原样；
// 已失效的地区引用不在保存时清理，留给重算时点名
function updatePreset(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const found = data.presets.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'PRESET_NOT_FOUND', '这个换算方案不存在或已被删除', '');

  if (input.name !== undefined) found.name = validatePresetName(input.name, data, found.id);
  if (input.zoneIds !== undefined) found.zones = validateZoneIds(input.zoneIds, data);
  if (input.sourceZoneId !== undefined) {
    const source = validateSourceZoneId(input.sourceZoneId, data);
    found.sourceZoneId = source.id;
    found.sourceName = source.name;
    found.sourceDisplayName = source.displayName;
  }
  if (input.dateFormat !== undefined) found.dateFormat = validateDateFormat(input.dateFormat);
  if (input.timeFormat !== undefined) found.timeFormat = validateTimeFormat(input.timeFormat);

  found.updatedAt = new Date().toISOString();
  save(data);
  return presentPreset(found);
}

function deletePreset(id) {
  const data = load();
  const index = data.presets.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'PRESET_NOT_FOUND', '这个换算方案不存在或已被删除', '');
  const [removed] = data.presets.splice(index, 1);
  save(data);
  return { id: removed.id, name: removed.name };
}

// 按方案重算：时刻取自页面当前填的日期与时刻，其余一律按方案存的设置来。
// 引用的地区被删了不算失败，点名缺哪几条，剩下的照算；
// 来源时区被删则没有了折算基准，只能指出问题让使用者改方案
function runPreset(id, options) {
  const input = options && typeof options === 'object' ? options : {};
  const data = load();
  const preset = data.presets.find((item) => item.id === id);
  if (!preset) throw new ApiError(404, 'PRESET_NOT_FOUND', '这个换算方案不存在或已被删除', '');

  const date = validateDate(input.date);
  const time = validateTime(input.time);

  const liveById = new Map(data.zones.map((zone) => [zone.id, zone]));
  const source = liveById.get(preset.sourceZoneId);
  if (!source) {
    const label = preset.sourceName || preset.sourceZoneId;
    throw new ApiError(409, 'PRESET_SOURCE_MISSING', `方案的来源时区 ${label} 已被删除，请编辑方案换一个来源时区`, '');
  }

  const missingZones = preset.zones.filter((ref) => !liveById.has(ref.zoneId));
  const targets = preset.zones.map((ref) => liveById.get(ref.zoneId)).filter(Boolean);
  if (!targets.length) {
    throw new ApiError(409, 'PRESET_ZONES_ALL_MISSING', '方案引用的地区都已被删除，没有可换算的地区，请编辑方案重新挑选', '');
  }

  const computed = computeConversion(date, time, source, targets);

  return {
    preset: presentPreset(preset),
    input: {
      date: date.text,
      time: time.text,
      zoneId: source.id,
      zoneName: source.name,
      zoneDisplayName: source.displayName,
      offsetText: offsetText(source.offsetMinutes),
      usesDst: source.usesDst,
    },
    standard: computed.standard,
    zonesInScope: targets.length,
    missingZones,
    missingCount: missingZones.length,
    crossDayCount: computed.crossDayCount,
    maxDiffMinutes: computed.maxDiffMinutes,
    results: computed.results,
    convertedAt: new Date().toISOString(),
  };
}

module.exports = {
  listPresets,
  getPreset,
  createPreset,
  updatePreset,
  deletePreset,
  runPreset,
};
