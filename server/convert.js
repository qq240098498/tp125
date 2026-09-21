const { load, WEEKDAY_NAMES, DATE_STYLES, TIME_STYLES, SCHEME_PREF_DEFAULTS } = require('./store');
const { ApiError, pickText } = require('./errors');
const { offsetText } = require('./zones');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 86400000;

const pad = (num) => String(num).padStart(2, '0');

// 日期要真存在，例如 2026-02-30 这种不能算数
function validateDate(value) {
  const date = pickText(value);
  if (!date) throw new ApiError(400, 'DATE_REQUIRED', '请填写日期', 'date');
  if (!DATE_PATTERN.test(date)) {
    throw new ApiError(400, 'DATE_INVALID', '日期要写成四位年加短横线加两位月日，例如 2026-09-20', 'date');
  }
  const [year, month, day] = date.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new ApiError(400, 'DATE_INVALID', '这个日期不存在，请检查月份与日', 'date');
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new ApiError(400, 'DATE_INVALID', '这个日期不存在，例如二月没有三十号', 'date');
  }
  return { text: date, year, month, day };
}

function validateTime(value) {
  const time = pickText(value);
  if (!time) throw new ApiError(400, 'TIME_REQUIRED', '请填写时刻', 'time');
  if (!TIME_PATTERN.test(time)) {
    throw new ApiError(400, 'TIME_INVALID', '时刻要写成两位小时加冒号加两位分钟，例如 09:30', 'time');
  }
  const [hour, minute] = time.split(':').map(Number);
  return { text: time, hour, minute };
}

// 写法偏好：日期支持短横线写法与中文写法，时刻支持二十四小时制与十二小时制
function resolvePrefs(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    dateStyle: DATE_STYLES.includes(source.dateStyle) ? source.dateStyle : SCHEME_PREF_DEFAULTS.dateStyle,
    timeStyle: TIME_STYLES.includes(source.timeStyle) ? source.timeStyle : SCHEME_PREF_DEFAULTS.timeStyle,
  };
}

function formatDate(year, month, day, dateStyle) {
  if (dateStyle === 'cn') return `${year} 年 ${month} 月 ${day} 日`;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function formatTime(hour, minute, timeStyle) {
  if (timeStyle === 'hour12') {
    const period = hour < 12 ? '上午' : '下午';
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    return `${period} ${hour12}:${pad(minute)}`;
  }
  return `${pad(hour)}:${pad(minute)}`;
}

// 时差写法：整小时只写小时，带分钟的把分钟也写出来
function diffText(minutes) {
  if (minutes === 0) return '与源时区相同';
  const sign = minutes > 0 ? '早' : '晚';
  const abs = Math.abs(minutes);
  const hour = Math.floor(abs / 60);
  const minute = abs % 60;
  const parts = [];
  if (hour) parts.push(`${hour} 小时`);
  if (minute) parts.push(`${minute} 分`);
  return `比源时区${sign} ${parts.join(' ')}`;
}

function dayOffsetText(dayOffset) {
  if (dayOffset === 0) return '同日';
  if (dayOffset > 0) return `后 ${dayOffset} 天`;
  return `前 ${Math.abs(dayOffset)} 天`;
}

// 把勾选的地区编号整理成不重复的清单，非字符串与空值一律忽略
function normalizeTargetIds(value) {
  if (!Array.isArray(value)) return null;
  const ids = [];
  value.forEach((item) => {
    if (typeof item === 'string' && item.trim() && !ids.includes(item)) ids.push(item);
  });
  return ids;
}

// 换算：先把输入时刻按来源时区的偏移折算成基准时刻，再逐个时区加上各自的偏移。
// targetIds 给了就只换算勾中的地区；其中对不上现存档案的编号放进 missingZones，
// 缺几条不影响其余地区继续算
function convert(options) {
  const input = options && typeof options === 'object' ? options : {};
  const date = validateDate(input.date);
  const time = validateTime(input.time);
  const zoneId = pickText(input.zoneId);
  if (!zoneId) throw new ApiError(400, 'ZONE_REQUIRED', '请选择来源时区', 'zoneId');

  const data = load();
  const source = data.zones.find((item) => item.id === zoneId);
  if (!source) throw new ApiError(404, 'ZONE_NOT_FOUND', '选中的时区没有登记过', 'zoneId');

  const prefs = resolvePrefs(input);
  const requestedIds = normalizeTargetIds(input.targetIds);
  if (requestedIds && requestedIds.length === 0) {
    throw new ApiError(400, 'TARGETS_REQUIRED', '请至少勾选一个地区再换算', 'targets');
  }
  let targetZones = data.zones;
  const missingZones = [];
  if (requestedIds) {
    targetZones = [];
    requestedIds.forEach((id) => {
      const found = data.zones.find((item) => item.id === id);
      if (found) {
        if (!targetZones.includes(found)) targetZones.push(found);
      } else {
        missingZones.push({ zoneId: id });
      }
    });
  }

  const baseMs = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  const utcMs = baseMs - source.offsetMinutes * 60000;
  const baseDay = Math.floor(baseMs / DAY_MS);
  const utcDate = new Date(utcMs);

  const results = targetZones.map((zone) => {
    const localMs = utcMs + zone.offsetMinutes * 60000;
    const local = new Date(localMs);
    const dayOffset = Math.floor(localMs / DAY_MS) - baseDay;
    const diffMinutes = zone.offsetMinutes - source.offsetMinutes;
    const year = local.getUTCFullYear();
    const month = local.getUTCMonth() + 1;
    const day = local.getUTCDate();
    const hour = local.getUTCHours();
    const minute = local.getUTCMinutes();
    return {
      zoneId: zone.id,
      name: zone.name,
      displayName: zone.displayName,
      offsetMinutes: zone.offsetMinutes,
      offsetText: offsetText(zone.offsetMinutes),
      localDate: formatDate(year, month, day, 'iso'),
      localTime: formatTime(hour, minute, 'hour24'),
      localDateText: formatDate(year, month, day, prefs.dateStyle),
      localTimeText: formatTime(hour, minute, prefs.timeStyle),
      weekday: WEEKDAY_NAMES[local.getUTCDay()],
      dayOffset,
      dayOffsetText: dayOffsetText(dayOffset),
      diffMinutes,
      diffText: diffText(diffMinutes),
      usesDst: zone.usesDst,
      isSource: zone.id === source.id,
    };
  });

  // 指定了地区清单时按勾选顺序出，没指定时维持按偏移排序的老口径
  if (!requestedIds) {
    results.sort((a, b) => {
      if (a.offsetMinutes !== b.offsetMinutes) return a.offsetMinutes - b.offsetMinutes;
      return a.name < b.name ? -1 : 1;
    });
  }

  return {
    input: {
      date: date.text,
      time: time.text,
      zoneId: source.id,
      zoneName: source.name,
      zoneDisplayName: source.displayName,
      offsetText: offsetText(source.offsetMinutes),
      usesDst: source.usesDst,
      prefs,
    },
    standard: {
      date: `${utcDate.getUTCFullYear()}-${pad(utcDate.getUTCMonth() + 1)}-${pad(utcDate.getUTCDate())}`,
      time: `${pad(utcDate.getUTCHours())}:${pad(utcDate.getUTCMinutes())}`,
    },
    zonesInScope: results.length,
    missingZones,
    crossDayCount: results.filter((item) => item.dayOffset !== 0).length,
    maxDiffMinutes: results.reduce((acc, item) => Math.max(acc, Math.abs(item.diffMinutes)), 0),
    results,
    convertedAt: new Date().toISOString(),
  };
}

module.exports = {
  convert,
  validateDate,
  validateTime,
  resolvePrefs,
  formatDate,
  formatTime,
  diffText,
  dayOffsetText,
};
