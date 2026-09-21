// 页面交互：时区档案、换算方案与换算台三块都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上

const state = {
  zones: [],
  allZones: [],
  counts: { total: 0, dstCount: 0, noDstCount: 0 },
  editingId: '',
  lastConvert: null,
  presets: [],
  presetEditingId: '',
  regionSelection: {},
  regionTouched: false,
};

const MONTHS = [
  ['1', '一月'], ['2', '二月'], ['3', '三月'], ['4', '四月'], ['5', '五月'], ['6', '六月'],
  ['7', '七月'], ['8', '八月'], ['9', '九月'], ['10', '十月'], ['11', '十一月'], ['12', '十二月'],
];
const WEEKS = [['1', '第一个'], ['2', '第二个'], ['3', '第三个'], ['4', '第四个'], ['last', '最后一个']];
const WEEKDAYS = [['0', '周日'], ['1', '周一'], ['2', '周二'], ['3', '周三'], ['4', '周四'], ['5', '周五'], ['6', '周六']];
// 日期与时刻写法的可选项，方案里存的也是这几个值
const DATE_FORMAT_OPTIONS = [['iso', '2026-09-20'], ['cn', '2026年9月20日'], ['dmy', '20/09/2026'], ['mdy', '09/20/2026']];
const TIME_FORMAT_OPTIONS = [['h24', '24 小时制（14:30）'], ['h12', '12 小时制（下午 2:30）']];
const DATE_FORMAT_LABEL = Object.fromEntries(DATE_FORMAT_OPTIONS);
const TIME_FORMAT_LABEL = Object.fromEntries(TIME_FORMAT_OPTIONS);

const el = (id) => document.getElementById(id);

// 统一的请求入口：出错时把服务端给的错误码、说明与出错位置一起抛出去
async function request(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch (err) {
    payload = null;
  }
  if (!res.ok) {
    const error = (payload && payload.error) || {};
    const failure = new Error(error.message || `请求失败（状态码 ${res.status}）`);
    failure.code = error.code || '';
    failure.field = error.field || '';
    throw failure;
  }
  return payload;
}

function notify(message, kind) {
  const box = el('notice');
  box.textContent = message;
  box.className = `notice ${kind === 'ok' ? 'ok' : 'error'}`;
}

function clearNotice() {
  const box = el('notice');
  box.className = 'notice hidden';
  box.textContent = '';
}

function clearFieldMarks() {
  document.querySelectorAll('.invalid').forEach((node) => node.classList.remove('invalid'));
}

function markField(field) {
  if (!field) return;
  const targets = document.querySelectorAll(`[data-field="${field}"]`);
  if (!targets.length) return;
  // 同名字段可能同时出现在多个表单里（比如方案名），只标当前看得见的那个
  const target = [...targets].find((node) => node.offsetParent !== null) || targets[0];
  target.classList.add('invalid');
  const input = target.matches('input, select, textarea') ? target : target.querySelector('input, select, textarea');
  if (input) input.focus();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 结果里的当地日期与时刻按当前生效的写法偏好渲染；原始值始终是 ISO 与 24 小时制
function formatDateText(isoDate, format) {
  const parts = String(isoDate || '').split('-');
  if (parts.length !== 3) return isoDate;
  const [year, month, day] = parts;
  if (format === 'cn') return `${Number(year)}年${Number(month)}月${Number(day)}日`;
  if (format === 'dmy') return `${day}/${month}/${year}`;
  if (format === 'mdy') return `${month}/${day}/${year}`;
  return isoDate;
}

function formatTimeText(time, format) {
  const parts = String(time || '').split(':');
  if (parts.length !== 2) return time;
  if (format !== 'h12') return time;
  const hour = Number(parts[0]);
  const minute = parts[1];
  const period = hour < 12 ? '上午' : '下午';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${period} ${hour12}:${minute}`;
}

const MONTH_LABEL = Object.fromEntries(MONTHS);
const WEEK_LABEL = Object.fromEntries(WEEKS);
const WEEKDAY_LABEL = Object.fromEntries(WEEKDAYS);

function ruleText(part) {
  if (!part) return '—';
  const hour = String(part.hour).padStart(2, '0');
  const minute = String(part.minute).padStart(2, '0');
  return `${MONTH_LABEL[String(part.month)] || part.month}${WEEK_LABEL[part.week] || part.week}${WEEKDAY_LABEL[String(part.weekday)] || part.weekday} ${hour}:${minute}`;
}

const OPERATOR_KEY = 'zone-clock-operator';

function currentOperator() {
  return el('operator').value.trim();
}

function restoreOperator() {
  el('operator').value = window.localStorage.getItem(OPERATOR_KEY) || '';
}

async function loadHealth() {
  try {
    await request('/api/health');
    el('health').textContent = '服务正常';
    el('health').className = 'health ok';
  } catch (err) {
    el('health').textContent = '服务连不上';
    el('health').className = 'health bad';
  }
}

function fillOptions() {
  const monthOptions = MONTHS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  const weekOptions = WEEKS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  const weekdayOptions = WEEKDAYS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  ['zone-start-month', 'zone-end-month'].forEach((id) => { el(id).innerHTML = monthOptions; });
  ['zone-start-week', 'zone-end-week'].forEach((id) => { el(id).innerHTML = weekOptions; });
  ['zone-start-weekday', 'zone-end-weekday'].forEach((id) => { el(id).innerHTML = weekdayOptions; });
  const dateFormatOptions = DATE_FORMAT_OPTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  const timeFormatOptions = TIME_FORMAT_OPTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  ['convert-date-format', 'preset-date-format'].forEach((id) => { el(id).innerHTML = dateFormatOptions; });
  ['convert-time-format', 'preset-time-format'].forEach((id) => { el(id).innerHTML = timeFormatOptions; });
}

async function loadZones() {
  const params = new URLSearchParams();
  const dst = el('zone-filter-dst').value;
  const keyword = el('zone-filter-keyword').value.trim();
  if (dst) params.set('dst', dst);
  if (keyword) params.set('keyword', keyword);
  const query = params.toString();
  const payload = await request(`/api/zones${query ? `?${query}` : ''}`);
  state.zones = payload.zones || [];
  state.counts = { total: payload.total || 0, dstCount: payload.dstCount || 0, noDstCount: payload.noDstCount || 0 };
  renderZones();
}

// 换算台用的完整档案清单：不受筛选条件影响，地区勾选与来源时区下拉都以它为准
async function loadAllZones() {
  const payload = await request('/api/zones');
  state.allZones = payload.zones || [];
  const live = new Set(state.allZones.map((zone) => zone.id));
  Object.keys(state.regionSelection).forEach((id) => {
    if (!live.has(id)) delete state.regionSelection[id];
  });
  // 第一次载入时默认全选，之后增删档案都保留使用者已经挑好的选择
  if (!state.regionTouched && !Object.keys(state.regionSelection).length) {
    state.allZones.forEach((zone) => { state.regionSelection[zone.id] = true; });
  }
  renderConvertZoneOptions();
  renderRegionPicker();
  renderPresets();
}

function renderZones() {
  el('zone-counts').textContent = `共登记 ${state.counts.total} 条档案，其中实行夏令时 ${state.counts.dstCount} 条，不实行 ${state.counts.noDstCount} 条；当前筛选出 ${state.zones.length} 条`;
  const body = el('zone-body');
  body.innerHTML = state.zones.map((item) => `<tr>
      <td class="mono">${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.displayName)}</td>
      <td class="mono">${escapeHtml(item.offsetText)}</td>
      <td>${item.usesDst ? '<span class="tag on">实行</span>' : '<span class="tag off">不实行</span>'}</td>
      <td class="mono">${item.dstOffsetText ? escapeHtml(item.dstOffsetText) : '—'}</td>
      <td class="rule-cell">${item.usesDst ? `${escapeHtml(ruleText(item.dstStart))} 起，${escapeHtml(ruleText(item.dstEnd))} 止` : '—'}</td>
      <td class="mono">${escapeHtml(item.yearRangeText)}</td>
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td class="actions">
        <button type="button" class="link" data-zone-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link danger" data-zone-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`).join('');
  el('zone-empty').classList.toggle('hidden', state.zones.length > 0);
}

function renderConvertZoneOptions() {
  const select = el('convert-zone');
  const current = select.value;
  select.innerHTML = state.allZones
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}　${escapeHtml(item.displayName)}</option>`)
    .join('');
  if (state.allZones.some((item) => item.id === current)) select.value = current;
}

// 地区勾选清单：页面当前的选择只影响页面换算，存进方案后两边各走各的
function renderRegionPicker() {
  el('region-list').innerHTML = state.allZones.map((zone) => `
    <label class="region-chip">
      <input type="checkbox" data-region="${escapeHtml(zone.id)}"${state.regionSelection[zone.id] ? ' checked' : ''}>
      <span class="mono">${escapeHtml(zone.name)}</span>
    </label>`).join('');
  updateRegionCount();
}

function selectedRegionIds() {
  return state.allZones.filter((zone) => state.regionSelection[zone.id]).map((zone) => zone.id);
}

function updateRegionCount() {
  el('region-count').textContent = `已选 ${selectedRegionIds().length} / ${state.allZones.length} 个地区`;
}

function openZoneForm(zone) {
  state.editingId = zone ? zone.id : '';
  el('zone-form-title').textContent = zone ? `编辑档案：${zone.name}` : '新建档案';
  el('zone-name').value = zone ? zone.name : '';
  el('zone-display').value = zone ? zone.displayName : '';
  el('zone-offset').value = zone ? String(zone.offsetMinutes) : '';
  el('zone-uses-dst').checked = zone ? zone.usesDst : false;
  el('zone-dst-offset').value = zone && zone.dstOffsetMinutes !== null ? String(zone.dstOffsetMinutes) : '';
  const start = zone && zone.dstStart ? zone.dstStart : { month: 3, week: '2', weekday: 0, hour: 2, minute: 0 };
  const end = zone && zone.dstEnd ? zone.dstEnd : { month: 11, week: '1', weekday: 0, hour: 2, minute: 0 };
  el('zone-start-month').value = String(start.month);
  el('zone-start-week').value = start.week;
  el('zone-start-weekday').value = String(start.weekday);
  el('zone-start-hour').value = String(start.hour);
  el('zone-start-minute').value = String(start.minute);
  el('zone-end-month').value = String(end.month);
  el('zone-end-week').value = end.week;
  el('zone-end-weekday').value = String(end.weekday);
  el('zone-end-hour').value = String(end.hour);
  el('zone-end-minute').value = String(end.minute);
  el('zone-from-year').value = zone ? String(zone.fromYear) : '';
  el('zone-to-year').value = zone && zone.toYear !== null ? String(zone.toYear) : '';
  el('zone-note').value = zone ? zone.note : '';
  el('zone-form').classList.remove('hidden');
  el('zone-name').focus();
}

function closeZoneForm() {
  state.editingId = '';
  el('zone-form').classList.add('hidden');
  clearFieldMarks();
}

async function submitZone(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    name: el('zone-name').value,
    displayName: el('zone-display').value,
    offsetMinutes: el('zone-offset').value,
    usesDst: el('zone-uses-dst').checked,
    dstOffsetMinutes: el('zone-dst-offset').value === '' ? null : el('zone-dst-offset').value,
    dstStart: {
      month: el('zone-start-month').value,
      week: el('zone-start-week').value,
      weekday: el('zone-start-weekday').value,
      hour: el('zone-start-hour').value,
      minute: el('zone-start-minute').value,
    },
    dstEnd: {
      month: el('zone-end-month').value,
      week: el('zone-end-week').value,
      weekday: el('zone-end-weekday').value,
      hour: el('zone-end-hour').value,
      minute: el('zone-end-minute').value,
    },
    fromYear: el('zone-from-year').value,
    toYear: el('zone-to-year').value === '' ? null : el('zone-to-year').value,
    note: el('zone-note').value,
  };
  if (!payload.usesDst) {
    payload.dstOffsetMinutes = null;
    payload.dstStart = null;
    payload.dstEnd = null;
  }
  const editing = state.editingId;
  try {
    if (editing) {
      await request(`/api/zones/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('时区档案已保存', 'ok');
    } else {
      await request('/api/zones', { method: 'POST', body: JSON.stringify(payload) });
      notify('时区档案已新增', 'ok');
    }
    closeZoneForm();
    await loadZones();
    await loadAllZones();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

function currentFormats() {
  return { dateFormat: el('convert-date-format').value, timeFormat: el('convert-time-format').value };
}

async function runConvert() {
  clearNotice();
  const zoneIds = selectedRegionIds();
  if (!zoneIds.length) {
    notify('请先在「换算地区」里勾选至少一个地区', 'error');
    markField('presetZones');
    return;
  }
  const payload = {
    date: el('convert-date').value,
    time: el('convert-time').value,
    zoneId: el('convert-zone').value,
    zoneIds,
  };
  try {
    const result = await request('/api/convert', { method: 'POST', body: JSON.stringify(payload) });
    state.lastConvert = { kind: 'page', formats: currentFormats(), ...result };
    renderConvert();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

// 结果渲染：页面换算与方案重算共用一张表，写法偏好用各自当时生效的那一份
function renderConvert() {
  const data = state.lastConvert;
  if (!data) return;
  const formats = data.formats;
  const maxDiffText = `${Math.floor(data.maxDiffMinutes / 60)} 小时 ${data.maxDiffMinutes % 60} 分`;
  const inputText = `${formatDateText(data.input.date, formats.dateFormat)} ${formatTimeText(data.input.time, formats.timeFormat)}`;
  if (data.kind === 'preset') {
    const preset = data.preset;
    const savedText = `方案存于 ${formatTime(preset.createdAt)}${preset.updatedAt !== preset.createdAt ? `，更新于 ${formatTime(preset.updatedAt)}` : ''}`;
    el('convert-meta').textContent = `按方案「${preset.name}」重算（${savedText}）：来源 ${data.input.zoneName}（${data.input.zoneDisplayName}，${data.input.offsetText}）的 ${inputText}，换算时刻 ${formatTime(data.convertedAt)}；参与换算的地区 ${data.zonesInScope} 个，与来源不同天的有 ${data.crossDayCount} 个，最大时差 ${maxDiffText}`;
  } else {
    el('convert-meta').textContent = `按页面当前设置换算：来源 ${data.input.zoneName}（${data.input.zoneDisplayName}，${data.input.offsetText}）的 ${inputText}，换算时刻 ${formatTime(data.convertedAt)}；参与换算的地区 ${data.zonesInScope} 个，与来源不同天的有 ${data.crossDayCount} 个，最大时差 ${maxDiffText}`;
  }
  const missingBox = el('convert-missing');
  if (data.kind === 'preset' && data.missingZones && data.missingZones.length) {
    const names = data.missingZones.map((ref) => `${ref.name || ref.zoneId}${ref.displayName ? `（${ref.displayName}）` : ''}`).join('、');
    missingBox.textContent = `方案里有 ${data.missingZones.length} 个地区已被删除，未参与本次换算：${names}。已按剩余 ${data.zonesInScope} 个地区完成换算。`;
    missingBox.classList.remove('hidden');
  } else {
    missingBox.classList.add('hidden');
    missingBox.textContent = '';
  }
  const body = el('convert-body');
  body.innerHTML = data.results.map((item) => `<tr class="${item.isSource ? 'source-row' : ''}">
      <td class="mono">${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.displayName)}</td>
      <td class="mono">${escapeHtml(formatDateText(item.localDate, formats.dateFormat))}</td>
      <td class="mono">${escapeHtml(formatTimeText(item.localTime, formats.timeFormat))}</td>
      <td>${escapeHtml(item.weekday)}</td>
      <td><span class="tag ${item.dayOffset === 0 ? 'off' : 'warn'}">${escapeHtml(item.dayOffsetText)}</span></td>
      <td class="mono">${escapeHtml(item.offsetText)}</td>
      <td>${escapeHtml(item.diffText)}</td>
      <td>${item.usesDst ? '有规则' : '—'}</td>
    </tr>`).join('');
  el('convert-empty').classList.toggle('hidden', data.results.length > 0);
}

// ---- 换算方案 ----

async function loadPresets() {
  const payload = await request('/api/presets');
  state.presets = payload.presets || [];
  renderPresets();
}

// 方案列表：每个方案写清存的时间、引用的地区、来源时区与写法偏好；
// 引用的地区已经不在档案里的，当场标出来
function renderPresets() {
  const list = el('preset-list');
  el('preset-counts').textContent = state.presets.length ? `共保存 ${state.presets.length} 个方案` : '';
  el('preset-empty').classList.toggle('hidden', state.presets.length > 0);
  const zonesReady = state.allZones.length > 0;
  const live = new Set(state.allZones.map((zone) => zone.id));
  list.innerHTML = state.presets.map((preset) => {
    const chips = preset.zones.map((ref) => {
      const gone = zonesReady && !live.has(ref.zoneId);
      return `<span class="tag ${gone ? 'warn' : 'off'}" title="${escapeHtml(ref.displayName)}">${escapeHtml(ref.name)}${gone ? '（已删除）' : ''}</span>`;
    }).join(' ');
    const sourceGone = zonesReady && !live.has(preset.sourceZoneId);
    const savedText = `存于 ${formatTime(preset.createdAt)}${preset.updatedAt !== preset.createdAt ? ` · 更新于 ${formatTime(preset.updatedAt)}` : ''}`;
    return `<div class="preset-item">
      <div class="preset-main">
        <div class="preset-title">
          <strong>${escapeHtml(preset.name)}</strong>
          <span class="preset-time">${escapeHtml(savedText)}</span>
        </div>
        <div class="preset-detail">地区 ${preset.zoneCount} 个：${chips}</div>
        <div class="preset-detail">
          来源 <span class="mono">${escapeHtml(preset.sourceName)}</span>${sourceGone ? '<span class="tag warn">来源已删除，重算前请先编辑方案</span>' : ''}
          · 日期写法 ${escapeHtml(DATE_FORMAT_LABEL[preset.dateFormat] || preset.dateFormat)}
          · 时刻写法 ${escapeHtml(TIME_FORMAT_LABEL[preset.timeFormat] || preset.timeFormat)}
        </div>
      </div>
      <div class="preset-actions">
        <button type="button" data-preset-run="${escapeHtml(preset.id)}">按方案重算</button>
        <button type="button" class="link" data-preset-edit="${escapeHtml(preset.id)}">编辑</button>
        <button type="button" class="link danger" data-preset-delete="${escapeHtml(preset.id)}">删除</button>
      </div>
    </div>`;
  }).join('');
}

// 按方案重算：日期与时刻用换算台当前填的，其余一律按方案存的设置；
// 不动换算台上的任何选择，页面与方案各看各的
async function runPreset(id) {
  clearNotice();
  try {
    const result = await request(`/api/presets/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      body: JSON.stringify({ date: el('convert-date').value, time: el('convert-time').value }),
    });
    state.lastConvert = {
      kind: 'preset',
      formats: { dateFormat: result.preset.dateFormat, timeFormat: result.preset.timeFormat },
      ...result,
    };
    renderConvert();
    notify(`已按方案「${result.preset.name}」重算`, 'ok');
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

// 存为方案：把换算台当前的一组设置（勾选的地区、来源时区、写法偏好）快照下来
function openPresetSaveBar() {
  clearNotice();
  clearFieldMarks();
  const zoneIds = selectedRegionIds();
  if (!zoneIds.length) {
    notify('请先在「换算地区」里勾选至少一个地区，再存为方案', 'error');
    markField('presetZones');
    return;
  }
  const sourceOption = el('convert-zone').selectedOptions[0];
  const formats = currentFormats();
  el('preset-save-hint').textContent = `将保存：${zoneIds.length} 个地区 · 来源 ${sourceOption ? sourceOption.textContent : ''} · 日期写法 ${DATE_FORMAT_LABEL[formats.dateFormat]} · 时刻写法 ${TIME_FORMAT_LABEL[formats.timeFormat]}`;
  el('preset-save-bar').classList.remove('hidden');
  el('preset-save-name').focus();
}

function closePresetSaveBar() {
  el('preset-save-bar').classList.add('hidden');
  el('preset-save-name').value = '';
  clearFieldMarks();
}

async function confirmPresetSave() {
  clearNotice();
  clearFieldMarks();
  const payload = {
    name: el('preset-save-name').value,
    zoneIds: selectedRegionIds(),
    sourceZoneId: el('convert-zone').value,
    ...currentFormats(),
  };
  try {
    const preset = await request('/api/presets', { method: 'POST', body: JSON.stringify(payload) });
    notify(`方案「${preset.name}」已保存`, 'ok');
    closePresetSaveBar();
    await loadPresets();
  } catch (err) {
    notify(err.message, 'error');
    // 来源时区的问题标到换算台的下拉上，其余按接口给的位置标
    markField(err.field === 'presetSource' ? 'zoneId' : err.field);
  }
}

function openPresetForm(preset) {
  state.presetEditingId = preset.id;
  el('preset-form-title').textContent = `编辑方案：${preset.name}`;
  el('preset-name').value = preset.name;
  el('preset-source').innerHTML = state.allZones
    .map((zone) => `<option value="${escapeHtml(zone.id)}">${escapeHtml(zone.name)}　${escapeHtml(zone.displayName)}</option>`)
    .join('');
  if (state.allZones.some((zone) => zone.id === preset.sourceZoneId)) {
    el('preset-source').value = preset.sourceZoneId;
  }
  el('preset-date-format').value = preset.dateFormat;
  el('preset-time-format').value = preset.timeFormat;
  const live = new Set(state.allZones.map((zone) => zone.id));
  const checked = new Set(preset.zones.map((ref) => ref.zoneId));
  el('preset-form-regions').innerHTML = state.allZones.map((zone) => `
    <label class="region-chip">
      <input type="checkbox" data-preset-region="${escapeHtml(zone.id)}"${checked.has(zone.id) ? ' checked' : ''}>
      <span class="mono">${escapeHtml(zone.name)}</span>
    </label>`).join('');
  // 引用了但已被删除的地区列出来，保存后就不再跟着方案走；来源已删的也一并提醒
  const stale = preset.zones.filter((ref) => !live.has(ref.zoneId));
  const hints = [];
  if (!live.has(preset.sourceZoneId)) {
    hints.push(`来源时区 ${preset.sourceName || preset.sourceZoneId} 已被删除，请在下拉里重新选一个来源时区`);
  }
  if (stale.length) {
    hints.push(`有 ${stale.length} 个引用的地区已被删除：${stale.map((ref) => ref.name || ref.zoneId).join('、')}，保存后将不再包含它们`);
  }
  const hint = el('preset-stale-hint');
  if (hints.length) {
    hint.textContent = hints.join('；') + '。';
    hint.classList.remove('hidden');
  } else {
    hint.classList.add('hidden');
    hint.textContent = '';
  }
  el('preset-form').classList.remove('hidden');
  el('preset-name').focus();
}

function closePresetForm() {
  state.presetEditingId = '';
  el('preset-form').classList.add('hidden');
  clearFieldMarks();
}

async function submitPreset(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    name: el('preset-name').value,
    zoneIds: [...document.querySelectorAll('[data-preset-region]:checked')].map((node) => node.dataset.presetRegion),
    sourceZoneId: el('preset-source').value,
    dateFormat: el('preset-date-format').value,
    timeFormat: el('preset-time-format').value,
  };
  try {
    const preset = await request(`/api/presets/${encodeURIComponent(state.presetEditingId)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    notify(`方案「${preset.name}」已保存`, 'ok');
    closePresetForm();
    await loadPresets();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

// 列表上的操作用事件委托统一处理，列表重绘之后不需要重新绑定
document.addEventListener('click', async (event) => {
  const node = event.target.closest('button');
  if (!node) return;

  if (node.dataset.zoneEdit) {
    clearNotice();
    const found = state.zones.find((item) => item.id === node.dataset.zoneEdit);
    if (found) openZoneForm(found);
    return;
  }

  if (node.dataset.zoneDelete) {
    clearNotice();
    const found = state.zones.find((item) => item.id === node.dataset.zoneDelete);
    if (!window.confirm(`确定删除 ${found ? found.name : ''} 这条档案吗？`)) return;
    try {
      const removed = await request(`/api/zones/${encodeURIComponent(node.dataset.zoneDelete)}`, { method: 'DELETE' });
      if (state.editingId === node.dataset.zoneDelete) closeZoneForm();
      const referenced = removed.referencedBy && removed.referencedBy.length
        ? `；有 ${removed.referencedBy.length} 个方案引用了它（${removed.referencedBy.join('、')}），重算时会按剩余地区继续`
        : '';
      notify(`时区档案已删除${referenced}`, 'ok');
      await loadZones();
      await loadAllZones();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.presetRun) {
    runPreset(node.dataset.presetRun);
    return;
  }

  if (node.dataset.presetEdit) {
    clearNotice();
    const found = state.presets.find((item) => item.id === node.dataset.presetEdit);
    if (found) openPresetForm(found);
    return;
  }

  if (node.dataset.presetDelete) {
    clearNotice();
    const found = state.presets.find((item) => item.id === node.dataset.presetDelete);
    if (!window.confirm(`确定删除方案「${found ? found.name : ''}」吗？换算台上的设置不受影响。`)) return;
    try {
      await request(`/api/presets/${encodeURIComponent(node.dataset.presetDelete)}`, { method: 'DELETE' });
      if (state.presetEditingId === node.dataset.presetDelete) closePresetForm();
      notify('换算方案已删除', 'ok');
      await loadPresets();
    } catch (err) {
      notify(err.message, 'error');
    }
  }
});

el('zone-form').addEventListener('submit', submitZone);
el('zone-new').addEventListener('click', () => {
  clearNotice();
  openZoneForm(null);
});
el('zone-cancel').addEventListener('click', closeZoneForm);
el('zone-filter-apply').addEventListener('click', () => {
  clearNotice();
  loadZones().catch((err) => notify(err.message, 'error'));
});
el('zone-filter-reset').addEventListener('click', () => {
  el('zone-filter-dst').value = '';
  el('zone-filter-keyword').value = '';
  loadZones().catch((err) => notify(err.message, 'error'));
});
el('zone-refresh').addEventListener('click', () => {
  clearNotice();
  loadZones().catch((err) => notify(err.message, 'error'));
});
el('zone-filter-dst').addEventListener('change', () => {
  loadZones().catch((err) => notify(err.message, 'error'));
});
el('convert-run').addEventListener('click', runConvert);
el('operator').addEventListener('change', () => {
  window.localStorage.setItem(OPERATOR_KEY, currentOperator());
});

// 地区勾选：只改页面当前的选择，不碰任何已保存的方案
el('region-list').addEventListener('change', (event) => {
  const box = event.target.closest('[data-region]');
  if (!box) return;
  state.regionTouched = true;
  if (box.checked) state.regionSelection[box.dataset.region] = true;
  else delete state.regionSelection[box.dataset.region];
  updateRegionCount();
});
el('region-all').addEventListener('click', () => {
  state.regionTouched = true;
  state.allZones.forEach((zone) => { state.regionSelection[zone.id] = true; });
  renderRegionPicker();
});
el('region-none').addEventListener('click', () => {
  state.regionTouched = true;
  state.regionSelection = {};
  renderRegionPicker();
});

// 写法偏好改动时，页面换算的结果按新写法重排；方案重算的结果仍按方案存的写法
['convert-date-format', 'convert-time-format'].forEach((id) => {
  el(id).addEventListener('change', () => {
    if (state.lastConvert && state.lastConvert.kind === 'page') {
      state.lastConvert.formats = currentFormats();
      renderConvert();
    }
  });
});

el('preset-save-open').addEventListener('click', openPresetSaveBar);
el('preset-save-confirm').addEventListener('click', confirmPresetSave);
el('preset-save-cancel').addEventListener('click', closePresetSaveBar);
el('preset-form').addEventListener('submit', submitPreset);
el('preset-cancel').addEventListener('click', closePresetForm);
el('preset-refresh').addEventListener('click', () => {
  clearNotice();
  loadPresets().catch((err) => notify(err.message, 'error'));
});

// 页面打开时先把档案拉一遍，换算台的来源时区下拉与地区勾选按这份清单填
fillOptions();
restoreOperator();
loadHealth();
const now = new Date();
el('convert-date').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
el('convert-time').value = '09:30';
loadZones().catch((err) => notify(err.message, 'error'));
loadAllZones().catch((err) => notify(err.message, 'error'));
loadPresets().catch((err) => notify(err.message, 'error'));
