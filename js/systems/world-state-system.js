import { stateManager } from '../core/state-manager.js';
import { eventBus } from '../core/event-bus.js';
import { formatGameTime } from '../utils/format.js';
import { CANON_DATABASE } from '../data/canon-database.js';
import { FINAL_EVENT_STATUSES } from '../data/instruction-contract.js';
import { GAME_DAYS_PER_MONTH, GAME_TIME_PERIODS, gameTimePosition, parseGameCalendar } from '../utils/game-calendar.js';

class WorldStateSystem {
  getWorldState() {
    return {
      current_location: stateManager.get('世界·地点'),
      calendar: this.getCalendar(),
      timeline: stateManager.get('世界·年代'),
      month: stateManager.get('世界·月份'),
      weather: stateManager.get('世界·天气'),
      active_events: this.getActiveEvents(),
    };
  }

  getCurrentLocation() {
    return stateManager.get('世界·地点') || '木叶隐村';
  }

  setLocation(location) {
    stateManager.update([
      { key: '世界·地点', op: '=', value: location }
    ]);
    eventBus.emit('world:location-changed', { location });
  }

  getCalendar() {
    const calStr = stateManager.get('世界·时间');
    if (typeof calStr === 'string' && calStr.trim()) {
      return this._parseCalendarString(calStr);
    }
    const calObj = stateManager.getSub('_meta')?.calendar;
    if (calObj && typeof calObj === 'object' && (calObj.month || calObj.season || calObj.day)) {
      return this._validateCalendar(calObj);
    }
    return { year: '木叶48年', month: 1, day: 1, time_of_day: '清晨' };
  }

  _parseCalendarString(str) {
    const complete = parseGameCalendar(str);
    if (complete) return complete;
    // Preserve the legacy season/day notation when reading older saves.
    const result = { year: '木叶48年', month: 1, day: 1, time_of_day: '清晨' };
    const yearMatch = str.match(/木叶(\d+)年/);
    if (yearMatch) result.year = `木叶${yearMatch[1]}年`;
    const monthMatch = str.match(/(\d+)月/);
    if (monthMatch) {
      result.month = parseInt(monthMatch[1]);
    } else {
      const seasonMonthMap = { '春': 1, '夏': 4, '秋': 7, '冬': 10 };
      for (const [season, m] of Object.entries(seasonMonthMap)) {
        if (str.includes(season)) { result.month = m; break; }
      }
    }
    const newDayMatch = str.match(/(\d+)日/);
    const oldDayMatch = str.match(/第(\d+)天/);
    if (newDayMatch) result.day = parseInt(newDayMatch[1]);
    else if (oldDayMatch) result.day = parseInt(oldDayMatch[1]);
    const timeOrder = GAME_TIME_PERIODS;
    for (const t of timeOrder) {
      if (str.includes(t)) { result.time_of_day = t; break; }
    }
    return result;
  }

  advanceTime(mode = 'scene') {
    const cal = this._validateCalendar(this.getCalendar());
    const timeOrder = GAME_TIME_PERIODS;
    const { index: currentTimeIdx, beforeDawn } = gameTimePosition(cal.time_of_day);

    switch (mode) {
      case 'moment':
        cal.time_of_day = timeOrder[(currentTimeIdx + 1) % timeOrder.length];
        if (currentTimeIdx === timeOrder.length - 1 && !beforeDawn) {
          cal.day += 1;
          this._checkMonthChange(cal);
        }
        break;
      case 'scene':
        cal.time_of_day = timeOrder[Math.min(currentTimeIdx + 2, timeOrder.length - 1)];
        if (currentTimeIdx >= timeOrder.length - 2) {
          if (!beforeDawn) cal.day = (cal.day || 1) + 1;
          cal.time_of_day = timeOrder[0];
          this._checkMonthChange(cal);
        }
        break;
      case 'day':
        cal.day = (cal.day || 1) + 1;
        cal.time_of_day = timeOrder[0];
        this._checkMonthChange(cal);
        break;
    }

    cal.day = Math.max(1, Math.min(31, Number(cal.day) || 1));

    // B-02: 把 cal 序列化为字符串后再写入 schema 声明为 string 的 '世界·时间'，
    // 同时把结构化对象保存到 _meta.calendar 供下游消费。
    const calStr = formatGameTime(cal);
    stateManager.update([
      { key: '世界·时间', op: '=', value: calStr }
    ]);
    try {
      const meta = stateManager.getSub('_meta') || {};
      meta.calendar = { ...cal };
      stateManager.setSub('_meta', meta);
    } catch (err) {
      console.warn('[WorldState] 保存 _meta.calendar 失败:', err?.message);
    }
    stateManager.update([
      { key: '世界·月份', op: '=', value: cal.month }
    ]);
    eventBus.emit('world:time-advanced', { calendar: cal });
    return cal;
  }

  _validateCalendar(cal) {
    if (!cal || typeof cal !== 'object') {
      console.warn('[WorldState] Calendar is invalid, resetting to default');
      return { year: '木叶48年', month: 1, day: 1, time_of_day: '清晨' };
    }
    const seasonMonthMap = { '春': 1, '夏': 4, '秋': 7, '冬': 10 };
    return {
      year: cal.year || '木叶48年',
      month: (Number.isFinite(Number(cal.month))) ? Number(cal.month)
        : seasonMonthMap[cal.season] || 1,
      day: Number.isFinite(Number(cal.day)) && Number(cal.day) > 0 ? Number(cal.day) : 1,
      time_of_day: cal.time_of_day || '清晨'
    };
  }

  _checkMonthChange(cal) {
    if (cal.day > GAME_DAYS_PER_MONTH) {
      cal.day = 1;
      if (cal.month < 12) {
        cal.month = cal.month + 1;
      } else {
        cal.month = 1;
        cal.year = this._incrementYear(cal.year);
      }
    }
  }

  _incrementYear(yearStr) {
    const match = yearStr.match(/木叶(\d+)年/);
    if (match) {
      return `木叶${parseInt(match[1]) + 1}年`;
    }
    return yearStr;
  }

  getWeather() {
    return stateManager.get('世界·天气') || '晴';
  }

  setWeather(weather) {
    const validWeather = ['晴', '阴', '雨', '雪', '雾', '暴风雨', '多云', '大风', '雷阵雨'];
    if (!weather || !validWeather.includes(weather)) {
      console.warn('[WorldState] Invalid weather:', weather);
      return;
    }
    stateManager.update([
      { key: '世界·天气', op: '=', value: weather }
    ]);
  }

  triggerEvent(eventData) {
    if (!eventData || typeof eventData !== 'object') {
      console.warn('[WorldState] Invalid event data:', typeof eventData);
      return null;
    }
    const now = Date.now();
    const id = eventData.id || eventData.title || eventData.name || `event_${now}`;
    const status = String(eventData.status || 'triggered').toLowerCase();
    const timelineCheck = CANON_DATABASE.validateTimelineEventUpdate(eventData, {
      state: {
        '世界·时间': stateManager.get('世界·时间'),
        '世界·年代': stateManager.get('世界·年代')
      }
    });
    if (!timelineCheck.allowed) {
      console.warn('[WorldState] Rejected project timeline event update:', timelineCheck);
      eventBus.emit('state:invalid-write', { type: 'project-timeline', ...timelineCheck });
      return null;
    }
    const finalStatuses = new Set(FINAL_EVENT_STATUSES);

    const eventsStr = stateManager.get('世界·活跃事件') || '';
    const events = eventsStr ? eventsStr.split('\n').filter(Boolean) : [];
    const filteredEvents = events.filter(line => {
      try {
        const event = JSON.parse(line);
        return this._eventId(event) !== id;
      } catch { return line !== id; }
    });

    const entry = {
      ...eventData,
      id,
      status,
      description: eventData.description || eventData.desc || eventData.detail || '',
      updated_at: now,
      triggered_at: eventData.triggered_at || now
    };

    if (!finalStatuses.has(status)) filteredEvents.push(JSON.stringify(entry));

    stateManager.update([
      { key: '世界·活跃事件', op: '=', value: filteredEvents.join('\n') }
    ]);
    eventBus.emit('world:event-triggered', entry);
    return entry;
  }

  getActiveEvents() {
    const str = stateManager.get('世界·活跃事件') || '';
    if (!str.trim()) return [];
    return str.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return line; }
    });
  }

  getTimeline() {
    return stateManager.get('世界·年代') || '木叶48年';
  }
  _eventId(event) {
    if (event == null) return '';
    if (typeof event === 'string') return event;
    return event.id || event.title || event.name || event.description || '';
  }
}

export const worldStateSystem = new WorldStateSystem();
export default worldStateSystem;
