// Minutes are local wall-clock labels. Only the right edge can be 24:00.
function tlMinute(value) {
  if (value === '24:00') {
    return 1440;
  }
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    return NaN;
  }
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

const tlClock = n => pad(Math.floor(n / 60)) + ':' + pad(n % 60);

const tlDuration = n => n >= 60 ? Math.floor(n / 60) + ' 小时' + (n % 60 ? ' ' + n % 60 + ' 分' : '') : n + ' 分';

function tlSplit(timer, finish) {
  const start = new Date(timer.startISO), end = new Date(finish), parts = [];
  if (!Number.isFinite(+start) || !Number.isFinite(+end) || end <= start) {
    return parts;
  }
  let cursor = start;
  while (cursor < end) {
    const midnight = new Date(cursor);
    midnight.setHours(24, 0, 0, 0);
    const stop = new Date(Math.min(+midnight, +end)), left = hm(cursor), right = +stop === +midnight ? '24:00' : hm(stop);
    if (right > left) {
      parts.push({
        date: ymd(cursor),
        row: {
          id: newId(),
          start: left,
          end: right,
          cat: timer.cat,
          label: timer.label || '',
          src: 'timer',
          ...timer.planId ? {
            planId: timer.planId
          } : {}
        }
      });
    }
    cursor = stop;
  }
  return parts;
}

const tlOverlap = (a, b) => a.start < b.end && b.start < a.end;

function tlInsert(rows, row, crop = false) {
  const rest = rows.filter(x => x.id !== row.id), conflicts = rest.filter(x => tlOverlap(x, row));
  if (conflicts.length && !crop) {
    return {
      conflicts: conflicts
    };
  }
  const result = [ row ];
  for (const x of rest) {
    if (!tlOverlap(x, row)) {
      result.push(x);
      continue;
    }
    if (x.start < row.start) {
      result.push({
        ...x,
        end: row.start
      });
    }
    if (x.end > row.end) {
      result.push({
        ...x,
        id: x.start < row.start ? newId() : x.id,
        start: row.end
      });
    }
  }
  return {
    rows: result.sort((a, b) => a.start.localeCompare(b.start))
  };
}

function tlSummary(day, horizon = 1440) {
  const actual = day.tl || [], plans = day.plan || [], categories = new Map, done = new Set, byPlan = new Map(plans.map(p => [ p.id, 0 ]));
  let recorded = 0;
  for (const row of actual) {
    const a = tlMinute(row.start), b = tlMinute(row.end);
    if (!(b > a)) {
      continue;
    }
    categories.set(row.cat, (categories.get(row.cat) || 0) + b - a);
    recorded += Math.max(0, Math.min(b, horizon) - a);
    for (const p of plans) {
      const linked = row.planId === p.id;
      if (!linked && row.cat !== p.cat) {
        continue;
      }
      const lo = linked ? a : Math.max(a, tlMinute(p.start)), hi = linked ? b : Math.min(b, tlMinute(p.end));
      if (hi <= lo) {
        continue;
      }
      byPlan.set(p.id, byPlan.get(p.id) + hi - lo);
      for (let m = lo; m < hi; m++) {
        done.add(m);
      }
    }
  }
  return {
    categories: categories,
    unrecorded: Math.max(0, horizon - recorded),
    byPlan: byPlan,
    completed: done.size,
    planned: plans.reduce((n, p) => n + tlMinute(p.end) - tlMinute(p.start), 0)
  };
}

const tlDefaultNames = [ '上课', '学习', '运动', '吃饭', '娱乐', '社交', '休息', '睡觉', '通勤', '杂事' ];

const tlColors = [ '#315747', '#496746', '#a94c37', '#e5a386', '#868e83', '#b6cfa0', '#bacfa6', '#57635a', '#6f8070', '#626c62' ];

const tlDefaults = tlDefaultNames.map((name, i) => ({
  id: 'c' + i,
  name: name,
  color: tlColors[i]
}));

const tlCats = () => Array.isArray(S.meta.tlcats) ? S.meta.tlcats : tlDefaults;

const tlCat = id => tlCats().find(c => c.id === id) || {
  id: id,
  name: '已删除的类别',
  color: '#837e78'
};

function tlParsePlan(text) {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length || lines.length > 12) {
    return null;
  }
  const rows = [];
  for (const line of lines) {
    const m = /^(\d\d:\d\d)\s*[-–]\s*(\d\d:\d\d)\s+(\S{1,30})(?:\s+(.{1,160}))?$/.exec(line.trim());
    if (!m || !(tlMinute(m[1]) < tlMinute(m[2]))) {
      return null;
    }
    rows.push({
      start: m[1],
      end: m[2],
      name: m[3],
      label: m[4] || ''
    });
  }
  return rows;
}
