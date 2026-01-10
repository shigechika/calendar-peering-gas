// グローバル設定オブジェクト
let CONFIG = {};
let LOG_BUFFER = []; // Discord通知用バッファ
let HOLIDAY_CAL = null;
let WORK_CAL = null;

function myFunction() {
  main();
}

/**
 * エントリーポイント
 */
function main() {
  loadConfig();
  console.log(`設定ロード完了: 期間=${CONFIG.SYNC_DAYS}日, 週末=[${CONFIG.WEEKEND_DAYS.join(',')}]`);

  // 1. Work -> Home (休日は自動同期)
  syncDirection(
    CONFIG.WORK_CALENDAR_ID, 
    CONFIG.HOME_CALENDAR_ID, 
    {
      tag: CONFIG.TAG_TO_HOME,
      mask: false,
      autoSyncHolidays: true,
      autoSyncWeekdays: false
    }
  );

  // 2. Home -> Work (平日は自動ブロック)
  syncDirection(
    CONFIG.HOME_CALENDAR_ID, 
    CONFIG.WORK_CALENDAR_ID, 
    {
      tag: CONFIG.TAG_TO_WORK,
      mask: true,
      autoSyncHolidays: false,
      autoSyncWeekdays: true
    }
  );

  // 3. Discord通知 (変更があった場合のみ)
  if (LOG_BUFFER.length > 0) {
    sendDiscord();
  } else {
    console.log("変更なしのため通知しません");
  }
}

/**
 * 設定読み込み (デフォルト30日)
 */
function loadConfig() {
  const props = PropertiesService.getScriptProperties().getProperties();

  if (!props.WORK_CALENDAR_ID || !props.HOME_CALENDAR_ID) {
    throw new Error("【エラー】スクリプトプロパティに WORK_CALENDAR_ID と HOME_CALENDAR_ID を設定してください。");
  }

  CONFIG = {
    WORK_CALENDAR_ID: props.WORK_CALENDAR_ID,
    HOME_CALENDAR_ID: props.HOME_CALENDAR_ID,
    DISCORD_WEBHOOK_URL: props.DISCORD_WEBHOOK_URL,
    
    TAG_TO_HOME: props.TAG_TO_HOME || '[Home]',
    TAG_TO_WORK: props.TAG_TO_WORK || '[Work]',
    MASK_TITLE:  props.MASK_TITLE || '休暇',
    
    SYNC_DAYS:   parseInt(props.SYNC_DAYS || '30', 10),
    WEEKEND_DAYS: (props.WEEKEND_DAYS || '0,6').split(',').map(num => parseInt(num.trim(), 10)),
    HOLIDAY_IGNORE_LIST: (props.HOLIDAY_IGNORE_LIST || '節分,バレンタイン,雛祭り,母の日,父の日,七夕,ハロウィン,クリスマス').split(','),
    CUSTOM_HOLIDAY_KEYWORDS: (props.CUSTOM_HOLIDAY_KEYWORDS || '創立記念日').split(',').filter(s => s.trim()).map(s => s.trim())
  };
}

/**
 * 同期ロジック
 */
function syncDirection(sourceId, targetId, options) {
  const sourceCal = CalendarApp.getCalendarById(sourceId);
  const targetCal = CalendarApp.getCalendarById(targetId);

  if (!sourceCal || !targetCal) {
    console.error(`カレンダーが見つかりません: ${sourceId} または ${targetId}`);
    return;
  }

  const now = new Date();
  const endDate = new Date();
  endDate.setDate(now.getDate() + CONFIG.SYNC_DAYS);

  const sourceEvents = sourceCal.getEvents(now, endDate);
  const targetEvents = targetCal.getEvents(now, endDate);

  // マップ作成
  const targetMap = {};
  targetEvents.forEach(e => {
    const originId = e.getTag('origin_id');
    const sourceCalTag = e.getTag('source_calendar_id');
    // 【重要】自分がこの方向で作成したイベントのみを管理対象にする
    if (originId && sourceCalTag === sourceId) {
      targetMap[originId] = e;
    }
  });

  // --- Upsert ---
  sourceEvents.forEach(sEvent => {
    // 無限ループ防止: 既にボットが作ったイベントなら無視
    if (sEvent.getTag('origin_id')) return;

    const sTitle = sEvent.getTitle();
    const sStart = sEvent.getStartTime();
    const isHolidayOrWeekend = checkHolidayOrWeekend(sStart);
    
    let shouldSync = false;

    // A. タグ判定
    if (sTitle.includes(options.tag)) {
      shouldSync = true;
    } 
    // B. 自動同期判定
    else {
      if (options.autoSyncHolidays && isHolidayOrWeekend) {
        shouldSync = true;
      }
      if (options.autoSyncWeekdays && !isHolidayOrWeekend) {
        shouldSync = true;
      }
    }

    if (shouldSync) {
      const targetTitle = options.mask ? CONFIG.MASK_TITLE : sTitle;
      const originId = sEvent.getId();
      const lastUpdated = sEvent.getLastUpdated().toISOString();

      if (targetMap[originId]) {
        const tEvent = targetMap[originId];
        const storedUpdated = tEvent.getTag('origin_updated');
        
        if (storedUpdated !== lastUpdated) {
          tEvent.deleteEvent(); // 更新のため削除して作り直し
          createTargetEvent(targetCal, sEvent, targetTitle, originId, lastUpdated, sourceId);
          recordLog(`🔄 更新: ${targetTitle} (${formatDate(sStart)})`);
        }
        delete targetMap[originId]; // 処理済みなのでマップから削除
      } else {
        createTargetEvent(targetCal, sEvent, targetTitle, originId, lastUpdated, sourceId);
        recordLog(`✨ 新規: ${targetTitle} (${formatDate(sStart)})`);
      }
    }
  });

  // --- Delete ---
  for (const key in targetMap) {
    const tEvent = targetMap[key];
    const sourceCalTag = tEvent.getTag('source_calendar_id');
  
    // 念のためタグチェック (マップ生成時にもやっているが二重チェック)
    if (sourceCalTag !== sourceId) continue;

    const title = tEvent.getTitle();
    const start = tEvent.getStartTime();
    tEvent.deleteEvent();
    recordLog(`🗑️ 削除: ${title} (${formatDate(start)})`);
  }
}

/**
 * イベント作成ヘルパー
 */
function createTargetEvent(cal, sEvent, title, originId, updatedStr, sourceCalId) {
  let newEvent;
  
  if (sEvent.isAllDayEvent()) {
    // 【修正2】冗長な if 文を削除し整理
    const startDate = sEvent.getAllDayStartDate();
    const endDate = sEvent.getAllDayEndDate();
    
    // 1日のみか複数日か判定 (差分が24時間(86400000ms)より大きいなら複数日)
    if (endDate.getTime() - startDate.getTime() > 86400000) {
      newEvent = cal.createAllDayEvent(title, startDate, endDate);
    } else {
      newEvent = cal.createAllDayEvent(title, startDate);
    }
  } else {
    newEvent = cal.createEvent(title, sEvent.getStartTime(), sEvent.getEndTime());
  }
  
  newEvent.setDescription(`Auto-synced via GAS.\nOriginal Update: ${updatedStr}`);
  newEvent.setTag('origin_id', originId);
  newEvent.setTag('origin_updated', updatedStr);
  newEvent.setTag('source_calendar_id', sourceCalId); // 同期元のIDを記録
}

/**
 * 休日・週末判定
 */
function checkHolidayOrWeekend(date) {
  // 1. 週末チェック
  const day = date.getDay();
  if (CONFIG.WEEKEND_DAYS.includes(day)) {
    return true;
  }

  // 2. 日本の祝日カレンダーチェック
  if (!HOLIDAY_CAL) {
    HOLIDAY_CAL = CalendarApp.getCalendarById('ja.japanese#holiday@group.v.calendar.google.com');
  }
  if (HOLIDAY_CAL) {
    const events = HOLIDAY_CAL.getEventsForDay(date);
    const ignoreList = CONFIG.HOLIDAY_IGNORE_LIST;
    const isPublicHoliday = events.some(e => {
      const title = e.getTitle();
      return !ignoreList.some(ignoreWord => title.includes(ignoreWord));
    });
    if (isPublicHoliday) return true;
  }

  // 3. 職場カレンダーの独自休日チェック
  if (CONFIG.WORK_CALENDAR_ID && CONFIG.CUSTOM_HOLIDAY_KEYWORDS.length > 0) {
    if (!WORK_CAL) {
      WORK_CAL = CalendarApp.getCalendarById(CONFIG.WORK_CALENDAR_ID);
    }
    
    if (WORK_CAL) {
      const workEvents = WORK_CAL.getEventsForDay(date);
      const isCustomHoliday = workEvents.some(e => {
        // 終日イベント以外は無視
        if (!e.isAllDayEvent()) return false; 
        
        const title = e.getTitle();
        return CONFIG.CUSTOM_HOLIDAY_KEYWORDS.some(keyword => title.includes(keyword));
      });
      if (isCustomHoliday) return true;
    }
  }

  return false;
}

/**
 * ログ記録ヘルパー
 */
function recordLog(msg) {
  console.log(msg);
  LOG_BUFFER.push(msg);
}

/**
 * Discord通知送信
 */
function sendDiscord() {
  if (!CONFIG.DISCORD_WEBHOOK_URL) return;

  const message = LOG_BUFFER.join("\n");
  const payload = {
    content: `**📅 Calendar Sync Report**\n${message}`
  };

  try {
    UrlFetchApp.fetch(CONFIG.DISCORD_WEBHOOK_URL, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload)
    });
    console.log("Discord通知送信完了");
  } catch (e) {
    console.error("Discord送信エラー: " + e.toString());
  }
}

/**
 * 日付フォーマット
 */
function formatDate(date) {
  return Utilities.formatDate(date, 'Asia/Tokyo', 'MM/dd HH:mm');
}

/**
 * プロパティ枠作成用
 */
function setupProperties() {
  const props = PropertiesService.getScriptProperties();
  const current = props.getProperties();
  
  const defaults = {
    'WORK_CALENDAR_ID': '',
    'HOME_CALENDAR_ID': '',
    'DISCORD_WEBHOOK_URL': '',
    'TAG_TO_HOME': '[Home]',
    'TAG_TO_WORK': '[Work]',
    'MASK_TITLE': '休暇',
    'SYNC_DAYS': '30',
    'WEEKEND_DAYS': '0,6'
  };

  for (const [key, val] of Object.entries(defaults)) {
    if (!current[key]) {
      props.setProperty(key, val);
    }
  }
  console.log("プロパティの枠を作成しました。");
}

/**
 * デバッグ用：WORKカレンダーとHOMEカレンダーにアクセスできるかチェック
 */
  
function testAccess() {
  const props = PropertiesService.getScriptProperties().getProperties();
  const workId = props.WORK_CALENDAR_ID;
  const homeId = props.HOME_CALENDAR_ID;

  const workCal = CalendarApp.getCalendarById(workId);
  const homeCal = CalendarApp.getCalendarById(homeId);

  console.log(`WORK(${workId}): ${workCal ? "OK ✅" : "NG ❌ (見つかりません)"}`);
  console.log(`HOME(${homeId}): ${homeCal ? "OK ✅" : "NG ❌ (見つかりません)"}`);
}
