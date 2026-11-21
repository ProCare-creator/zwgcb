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

// Project the timer onto the selected civil day without writing a partial row.
function tlLiveSlice(timer,date,now) {
  if (!timer || !date) return null;
  const start=new Date(timer.startISO);
  if (!(start<=now) || date<ymd(start) || date>ymd(now)) return null;
  return {...timer,start:date===ymd(start)?hm(start):'00:00',end:date===ymd(now)?hm(now):'24:00',live:true};
}
function tlSummary(day,horizon=1440,live=null,otherDays={}) {
  const actual=day.tl||[], plans=day.plan||[], categories=new Map(), occupied=new Set();
  const minutes=new Map(plans.map(p=>[p.id,new Set()]));
  const activePlans=new Set();
  function count(row, local, date='') {
    const start=tlMinute(row.start), end=tlMinute(row.end);
    for(let m=start;m<end;m++) {
      if(local) {
        if(occupied.has(m))continue;
        occupied.add(m);
        categories.set(row.cat,(categories.get(row.cat)||0)+1);
      }
      for(const p of plans){
        if(row.planId!==p.id && !(local && row.cat===p.cat && m>=tlMinute(p.start) && m<tlMinute(p.end))) continue;
        minutes.get(p.id).add(date+':'+m);
        if(row.live)activePlans.add(p.id);
      }
    }
  }
  for(const r of actual) count(r,true);
  if(live){if(!categories.has(live.cat))categories.set(live.cat,0);count(live,true);}
  if(plans.length)for(const [date,rows] of Object.entries(otherDays))for(const r of rows)if(minutes.has(r.planId))count(r,false,date);
  const credited=new Set(),byPlan=new Map();
  // Count each minute once. An overlapping plan can still use otherwise uncredited minutes.
  for(const p of plans){
    const matched=minutes.get(p.id);
    byPlan.set(p.id,matched.size);
    let budget=tlMinute(p.end)-tlMinute(p.start);
    for(const m of matched){if(budget<=0)break;if(!credited.has(m)){credited.add(m);budget--;}}
  }
  return {categories,byPlan,activePlans,completed:credited.size,
    unrecorded:Math.max(0,horizon-[...occupied].filter(m=>m<horizon).length),
    planned:plans.reduce((n,p)=>n+tlMinute(p.end)-tlMinute(p.start),0)};
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
