// 页面交互：时区档案、换算台与换算方案三块都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上。
// 换算台当前的选择与方案里存的设置各用各的状态：存方案只读取换算台当下的值，编辑、重算方案都不回写换算台。

const state = {
  zones: [],
  allZones: [],
  counts: { total: 0, dstCount: 0, noDstCount: 0 },
  editingId: '',
  lastConvert: null,
  schemes: [],
  editingSchemeId: '',
  // 换算台当前勾选的地区编号；方案表单勾选的编号只在表单打开期间存在 schemeSelected 里
  convertSelected: [],
  schemeSelected: [],
};

const MONTHS = [
  ['1', '一月'], ['2', '二月'], ['3', '三月'], ['4', '四月'], ['5', '五月'], ['6', '六月'],
  ['7', '七月'], ['8', '八月'], ['9', '九月'], ['10', '十月'], ['11', '十一月'], ['12', '十二月'],
];
const WEEKS = [['1', '第一个'], ['2', '第二个'], ['3', '第三个'], ['4', '第四个'], ['last', '最后一个']];
const WEEKDAYS = [['0', '周日'], ['1', '周一'], ['2', '周二'], ['3', '周三'], ['4', '周四'], ['5', '周五'], ['6', '周六']];
const DATE_STYLE_LABEL = { iso: '2026-09-20', cn: '2026 年 9 月 20 日' };
const TIME_STYLE_LABEL = { hour24: '24 小时制', hour12: '12 小时制' };

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

function clearFieldMarks(scope) {
  const root = scope || document;
  root.querySelectorAll('.invalid').forEach((node) => node.classList.remove('invalid'));
}

function markField(field, scope) {
  if (!field) return;
  const root = scope || document;
  const target = root.querySelector(`[data-field="${field}"]`);
  if (!target) return;
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
}

// 档案表格按筛选条件拉一份；换算台与方案的勾选清单、来源下拉始终用不带筛选的全量清单
async function loadZones() {
  const params = new URLSearchParams();
  const dst = el('zone-filter-dst').value;
  const keyword = el('zone-filter-keyword').value.trim();
  if (dst) params.set('dst', dst);
  if (keyword) params.set('keyword', keyword);
  const query = params.toString();
  const [filtered, full] = await Promise.all([
    request(`/api/zones${query ? `?${query}` : ''}`),
    request('/api/zones'),
  ]);
  state.zones = filtered.zones || [];
  state.counts = { total: filtered.total || 0, dstCount: filtered.dstCount || 0, noDstCount: filtered.noDstCount || 0 };
  state.allZones = full.zones || [];
  // 档案有删除时，把已经不存在的勾选 quietly 拿掉，页面其余选择保持不动
  const liveIds = new Set(state.allZones.map((item) => item.id));
  state.convertSelected = state.convertSelected.filter((id) => liveIds.has(id));
  renderZones();
  renderConvertZoneOptions();
  renderConvertTargets();
  renderSchemeZoneOptions();
  renderSchemeTargets();
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

// 换算台的地区勾选清单：勾选状态存在 state.convertSelected 里，重绘只按编号回填
function renderConvertTargets() {
  const box = el('convert-targets');
  const checked = new Set(state.convertSelected);
  box.innerHTML = state.allZones.map((item) => `<label class="pick-item">
      <input type="checkbox" data-convert-target="${escapeHtml(item.id)}"${checked.has(item.id) ? ' checked' : ''}>
      <span class="mono">${escapeHtml(item.name)}</span>
      <span>${escapeHtml(item.displayName)}</span>
      <span class="pick-offset">${escapeHtml(item.offsetText)}</span>
    </label>`).join('');
  el('targets-count').textContent = `已勾选 ${state.convertSelected.length} / ${state.allZones.length} 个地区`;
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
    await loadSchemes();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

// 换算台当前的写法偏好；方案重算时结果里带的是方案自己的偏好，渲染以结果为准
function currentConvertPrefs() {
  return {
    dateStyle: el('convert-date-style').value,
    timeStyle: el('convert-time-style').value,
  };
}

async function runConvert() {
  clearNotice();
  const payload = {
    date: el('convert-date').value,
    time: el('convert-time').value,
    zoneId: el('convert-zone').value,
    targetIds: state.convertSelected,
    ...currentConvertPrefs(),
  };
  try {
    const result = await request('/api/convert', { method: 'POST', body: JSON.stringify(payload) });
    state.lastConvert = result;
    renderConvert(result);
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

function showConvertWarning(result) {
  const box = el('convert-warn');
  const missing = result.missingZones || [];
  if (missing.length === 0) {
    box.className = 'convert-warn hidden';
    box.textContent = '';
    return;
  }
  const names = missing.map((item) => item.name || item.displayName || item.zoneId).join('、');
  box.textContent = `方案里有 ${missing.length} 个地区已经不在档案中（${names}），已按其余 ${result.zonesInScope} 个地区继续换算。`;
  box.className = 'convert-warn';
}

function renderConvert(result) {
  showConvertWarning(result);
  const schemeLine = result.scheme ? `按方案「${result.scheme.name}」重算；` : '';
  el('convert-meta').textContent = `${schemeLine}来源 ${result.input.zoneName}（${result.input.zoneDisplayName}，${result.input.offsetText}）的 ${result.input.date} ${result.input.time}，换算时刻 ${formatTime(result.convertedAt)}；参与换算的档案 ${result.zonesInScope} 条，与来源不同天的有 ${result.crossDayCount} 条，最大时差 ${Math.floor(result.maxDiffMinutes / 60)} 小时 ${result.maxDiffMinutes % 60} 分`;
  const body = el('convert-body');
  body.innerHTML = result.results.map((item) => `<tr class="${item.isSource ? 'source-row' : ''}">
      <td class="mono">${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.displayName)}</td>
      <td class="mono">${escapeHtml(item.localDateText || item.localDate)}</td>
      <td class="mono">${escapeHtml(item.localTimeText || item.localTime)}</td>
      <td>${escapeHtml(item.weekday)}</td>
      <td><span class="tag ${item.dayOffset === 0 ? 'off' : 'warn'}">${escapeHtml(item.dayOffsetText)}</span></td>
      <td class="mono">${escapeHtml(item.offsetText)}</td>
      <td>${escapeHtml(item.diffText)}</td>
      <td>${item.usesDst ? '有规则' : '—'}</td>
    </tr>`).join('');
  el('convert-empty').classList.toggle('hidden', result.results.length > 0);
}

// ---------- 换算方案 ----------

async function loadSchemes() {
  const payload = await request('/api/schemes');
  state.schemes = payload.schemes || [];
  renderSchemes();
}

function renderSchemes() {
  const counts = el('scheme-counts');
  if (state.schemes.length === 0) {
    counts.textContent = '还没有存过方案。把常用的一组地区、来源时区与日期、时刻写法存起来，下次点开就能直接重算';
  } else {
    const broken = state.schemes.filter((item) => item.sourceExists === false || item.missingCount > 0).length;
    counts.textContent = `已存 ${state.schemes.length} 个方案${broken ? `，其中 ${broken} 个引用了已删除的地区或来源时区` : ''}；点「按方案重算」会用换算台上当前的日期与时刻套方案设置`;
  }
  const body = el('scheme-body');
  body.innerHTML = state.schemes.map((item) => {
    const source = item.sourceExists
      ? `${escapeHtml(item.zoneName)}　${escapeHtml(item.zoneDisplayName)}`
      : '<span class="missing-text">来源时区已删除</span>';
    const targetPart = item.missingCount > 0
      ? `${item.targets.length - item.missingCount} 个 <span class="tag warn">${item.missingCount} 个已删除</span>`
      : `${item.targets.length} 个`;
    return `<tr>
      <td>${escapeHtml(item.name)}</td>
      <td>${source}</td>
      <td>${targetPart}</td>
      <td>${escapeHtml(DATE_STYLE_LABEL[item.dateStyle] || item.dateStyle)}</td>
      <td>${escapeHtml(TIME_STYLE_LABEL[item.timeStyle] || item.timeStyle)}</td>
      <td class="mono">${escapeHtml(formatTime(item.createdAt))}</td>
      <td class="actions">
        <button type="button" class="link" data-scheme-run="${escapeHtml(item.id)}">按方案重算</button>
        <button type="button" class="link" data-scheme-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link danger" data-scheme-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`;
  }).join('');
}

function renderSchemeZoneOptions() {
  const select = el('scheme-zone');
  if (!select) return;
  const current = select.value;
  select.innerHTML = state.allZones
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}　${escapeHtml(item.displayName)}</option>`)
    .join('');
  if (state.allZones.some((item) => item.id === current)) select.value = current;
}

// 方案表单的地区勾选：现存档案正常勾选；编辑旧方案时已删除的引用单列在下面且不可勾选
function renderSchemeTargets(missingEntries) {
  const box = el('scheme-targets');
  if (!box) return;
  const checked = new Set(state.schemeSelected);
  const live = state.allZones.map((item) => `<label class="pick-item">
      <input type="checkbox" data-scheme-target="${escapeHtml(item.id)}"${checked.has(item.id) ? ' checked' : ''}>
      <span class="mono">${escapeHtml(item.name)}</span>
      <span>${escapeHtml(item.displayName)}</span>
      <span class="pick-offset">${escapeHtml(item.offsetText)}</span>
    </label>`).join('');
  const gone = (missingEntries || [])
    .filter((item) => !state.allZones.some((zone) => zone.id === item.zoneId))
    .map((item) => `<label class="pick-item gone">
      <input type="checkbox" disabled>
      <span class="mono">${escapeHtml(item.name || item.zoneId)}</span>
      <span>${escapeHtml(item.displayName || '')}</span>
      <span class="missing-text">已删除，不再参与换算</span>
    </label>`)
    .join('');
  box.innerHTML = `${live}${gone ? `<div class="gone-head">方案里引用但已被删除的地区：</div>${gone}` : ''}`;
}

// scheme 给了就按方案自身的设置填表（与换算台无关）；否则从换算台当前选择预填，仅这一次复制
function openSchemeForm(scheme) {
  clearNotice();
  clearFieldMarks(el('scheme-form'));
  renderSchemeZoneOptions();
  if (scheme) {
    state.editingSchemeId = scheme.id;
    el('scheme-form-title').textContent = `编辑方案：${scheme.name}`;
    el('scheme-name').value = scheme.name;
    el('scheme-zone').value = scheme.zoneId;
    el('scheme-date-style').value = scheme.dateStyle;
    el('scheme-time-style').value = scheme.timeStyle;
    state.schemeSelected = scheme.targets.filter((item) => item.exists).map((item) => item.zoneId);
    renderSchemeTargets(scheme.targets.filter((item) => !item.exists));
    if (!scheme.sourceExists) {
      notify('这个方案的来源时区已被删除，请在下面重新选一个再保存，否则不能重算', 'error');
    }
  } else {
    state.editingSchemeId = '';
    el('scheme-form-title').textContent = '新建方案';
    el('scheme-name').value = '';
    el('scheme-zone').value = el('convert-zone').value;
    el('scheme-date-style').value = el('convert-date-style').value;
    el('scheme-time-style').value = el('convert-time-style').value;
    state.schemeSelected = state.convertSelected.slice();
    renderSchemeTargets([]);
  }
  el('scheme-form').classList.remove('hidden');
  el('scheme-name').focus();
}

function closeSchemeForm() {
  state.editingSchemeId = '';
  state.schemeSelected = [];
  el('scheme-form').classList.add('hidden');
  clearFieldMarks(el('scheme-form'));
}

async function submitScheme(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks(el('scheme-form'));
  const payload = {
    name: el('scheme-name').value,
    zoneId: el('scheme-zone').value,
    targets: state.schemeSelected,
    dateStyle: el('scheme-date-style').value,
    timeStyle: el('scheme-time-style').value,
  };
  const editing = state.editingSchemeId;
  try {
    if (editing) {
      await request(`/api/schemes/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('换算方案已保存', 'ok');
    } else {
      await request('/api/schemes', { method: 'POST', body: JSON.stringify(payload) });
      notify('换算方案已新增', 'ok');
    }
    closeSchemeForm();
    await loadSchemes();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field, el('scheme-form'));
  }
}

// 按方案重算：日期与时刻取换算台当前的值，地区、来源时区与写法偏好全部用方案里的；
// 不动换算台上的任何选择，下次点「换算一遍」仍是页面自己的设置
async function runScheme(id) {
  clearNotice();
  const payload = {
    date: el('convert-date').value,
    time: el('convert-time').value,
  };
  try {
    const result = await request(`/api/schemes/${encodeURIComponent(id)}/convert`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    state.lastConvert = result;
    renderConvert(result);
    notify(`已按方案「${result.scheme.name}」重算`, 'ok');
    el('convert-body').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    notify(err.message, 'error');
  }
}

// 勾选变化与列表上的操作用事件委托统一处理，列表重绘之后不需要重新绑定
document.addEventListener('click', async (event) => {
  const node = event.target.closest('button');
  if (!node) return;

  if (node.dataset.zoneEdit) {
    clearNotice();
    const found = state.allZones.find((item) => item.id === node.dataset.zoneEdit);
    if (found) openZoneForm(found);
    return;
  }

  if (node.dataset.zoneDelete) {
    clearNotice();
    const found = state.allZones.find((item) => item.id === node.dataset.zoneDelete);
    if (!window.confirm(`确定删除 ${found ? found.name : ''} 这条档案吗？引用它的方案重算时会标出缺失并继续。`)) return;
    try {
      await request(`/api/zones/${encodeURIComponent(node.dataset.zoneDelete)}`, { method: 'DELETE' });
      if (state.editingId === node.dataset.zoneDelete) closeZoneForm();
      notify('时区档案已删除', 'ok');
      await loadZones();
      await loadSchemes();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.schemeRun) {
    await runScheme(node.dataset.schemeRun);
    return;
  }

  if (node.dataset.schemeEdit) {
    const found = state.schemes.find((item) => item.id === node.dataset.schemeEdit);
    if (found) openSchemeForm(found);
    return;
  }

  if (node.dataset.schemeDelete) {
    const found = state.schemes.find((item) => item.id === node.dataset.schemeDelete);
    if (!window.confirm(`确定删除方案「${found ? found.name : ''}」吗？这不会影响换算台上当前的选择。`)) return;
    try {
      await request(`/api/schemes/${encodeURIComponent(node.dataset.schemeDelete)}`, { method: 'DELETE' });
      if (state.editingSchemeId === node.dataset.schemeDelete) closeSchemeForm();
      notify('换算方案已删除', 'ok');
      await loadSchemes();
    } catch (err) {
      notify(err.message, 'error');
    }
  }
});

// 勾选框都是重绘的，change 事件同样走委托
document.addEventListener('change', (event) => {
  const convertTarget = event.target.dataset && event.target.dataset.convertTarget;
  if (convertTarget) {
    if (event.target.checked) {
      if (!state.convertSelected.includes(convertTarget)) state.convertSelected.push(convertTarget);
    } else {
      state.convertSelected = state.convertSelected.filter((id) => id !== convertTarget);
    }
    el('targets-count').textContent = `已勾选 ${state.convertSelected.length} / ${state.allZones.length} 个地区`;
    return;
  }
  const schemeTarget = event.target.dataset && event.target.dataset.schemeTarget;
  if (schemeTarget) {
    if (event.target.checked) {
      if (!state.schemeSelected.includes(schemeTarget)) state.schemeSelected.push(schemeTarget);
    } else {
      state.schemeSelected = state.schemeSelected.filter((id) => id !== schemeTarget);
    }
  }
});

el('zone-form').addEventListener('submit', submitZone);
el('scheme-form').addEventListener('submit', submitScheme);
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
el('targets-all').addEventListener('click', () => {
  state.convertSelected = state.allZones.map((item) => item.id);
  renderConvertTargets();
});
el('targets-none').addEventListener('click', () => {
  state.convertSelected = [];
  renderConvertTargets();
});
el('scheme-targets-all').addEventListener('click', () => {
  state.schemeSelected = state.allZones.map((item) => item.id);
  renderSchemeTargets([]);
});
el('scheme-targets-none').addEventListener('click', () => {
  state.schemeSelected = [];
  renderSchemeTargets([]);
});
el('scheme-save-current').addEventListener('click', () => openSchemeForm(null));
el('scheme-new').addEventListener('click', () => openSchemeForm(null));
el('scheme-cancel').addEventListener('click', closeSchemeForm);
el('scheme-refresh').addEventListener('click', () => {
  clearNotice();
  loadSchemes().catch((err) => notify(err.message, 'error'));
});
el('operator').addEventListener('change', () => {
  window.localStorage.setItem(OPERATOR_KEY, currentOperator());
});

// 页面打开时先把档案与方案各拉一遍；换算台地区默认全选，来源时区下拉按全量清单填
fillOptions();
restoreOperator();
loadHealth();
const now = new Date();
el('convert-date').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
el('convert-time').value = '09:30';
(async function init() {
  try {
    await loadZones();
    state.convertSelected = state.allZones.map((item) => item.id);
    renderConvertTargets();
    await loadSchemes();
  } catch (err) {
    notify(err.message, 'error');
  }
}());
