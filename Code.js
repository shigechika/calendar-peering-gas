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

  if (CONFIG.DRY_RUN) {
    console.log("🚫 DRY_RUN MODE: 変更は適用されません");
  }
  console.log(`設定ロード完了: 期間=${CONFIG.SYNC_DAYS}日, 週末=[${CONFIG.WEEKEND_DAYS.join(',')}]`);

  // 1. Work -> Life
  syncDirection(
    CONFIG.WORK_CALENDAR_ID, 
    CONFIG.LIFE_CALENDAR_ID, 
    {
      keywords: CONFIG.SYNC_KEYWORDS_TO_LIFE,
      mask: CONFIG.MASK_WORK_TO_LIFE,
      maskTitle: CONFIG.MASK_TITLE_WORK,
      autoSyncHolidays: true,
      autoSyncWeekdays: false
    }
  );

  // 2. Life -> Work
  syncDirection(
    CONFIG.LIFE_CALENDAR_ID, 
    CONFIG.WORK_CALENDAR_ID, 
    {
      keywords: CONFIG.SYNC_KEYWORDS_TO_WORK,
      mask: true,
      maskTitle: CONFIG.MASK_TITLE_LIFE,
      autoSyncHolidays: false,
      autoSyncWeekdays: true
    }
  );

  if (LOG_BUFFER.length > 0) {
    sendNotifications();
  } else {
    console.log("変更なしのため通知しません");
  }
}

/**
 * 設定読み込み (デフォルト30日)
 */
function loadConfig() {
  const props = PropertiesService.getScriptProperties().getProperties();

  if (!props.WORK_CALENDAR_ID || !props.LIFE_CALENDAR_ID) {
    throw new Error("【エラー】スクリプトプロパティに WORK_CALENDAR_ID と LIFE_CALENDAR_ID を設定してください。");
  }

  CONFIG = {
    WORK_CALENDAR_ID: props.WORK_CALENDAR_ID,
    LIFE_CALENDAR_ID: props.LIFE_CALENDAR_ID,
    DISCORD_WEBHOOK_URL: props.DISCORD_WEBHOOK_URL,
    GOOGLE_CHAT_WEBHOOK_URL: props.GOOGLE_CHAT_WEBHOOK_URL,

		SYNC_KEYWORDS_TO_LIFE: (props.SYNC_KEYWORDS_TO_LIFE || '[Life],出張,深夜作業').split(',').map(s => s.trim()).filter(s => s),
		SYNC_KEYWORDS_TO_WORK: (props.SYNC_KEYWORDS_TO_WORK || '[Work],通院,役所').split(',').map(s => s.trim()).filter(s => s),
			
    MASK_TITLE_WORK: props.MASK_TITLE_WORK || '仕事', // Work -> Life 時のタイトル
    MASK_TITLE_LIFE: props.MASK_TITLE_LIFE || '休暇', // Life -> Work 時のタイトル (旧 MASK_TITLE)
    MASK_WORK_TO_LIFE: (props.MASK_WORK_TO_LIFE || 'false').toLowerCase() === 'true',
    
    SYNC_DAYS:   parseInt(props.SYNC_DAYS || '30', 10),
    WEEKEND_DAYS: (props.WEEKEND_DAYS || '0,6').split(',').map(num => parseInt(num.trim(), 10)),
    HOLIDAY_IGNORE_LIST: (props.HOLIDAY_IGNORE_LIST || '節分,バレンタイン,雛祭り,母の日,父の日,七夕,ハロウィン,クリスマス').split(','),
    CUSTOM_HOLIDAY_KEYWORDS: (props.CUSTOM_HOLIDAY_KEYWORDS || '').split(',').filter(s => s.trim()).map(s => s.trim()),
    DRY_RUN: (props.DRY_RUN || 'false').toLowerCase() === 'true'
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
    if (originId && sourceCalTag === sourceId) {
      targetMap[originId] = e;
    }
  });

  // --- Upsert ---
  sourceEvents.forEach(sEvent => {
    if (sEvent.getTag('origin_id')) return;

    const sTitle = sEvent.getTitle();
    const sStart = sEvent.getStartTime();
    const isHolidayOrWeekend = checkHolidayOrWeekend(sStart);
    
    let shouldSync = false;

    // Issue #8: 複数キーワードチェック（部分一致）
    const keywordMatch = options.keywords.some(keyword => sTitle.includes(keyword));
    if (keywordMatch) {
      shouldSync = true;
    } else {
      if (options.autoSyncHolidays && isHolidayOrWeekend) shouldSync = true;
      if (options.autoSyncWeekdays && !isHolidayOrWeekend) shouldSync = true;
    }

    if (shouldSync) {
      // Issue #9: maskオプションに応じてタイトル決定
      const targetTitle = options.mask ? options.maskTitle : sTitle;
      const originId = sEvent.getId();
      const lastUpdated = sEvent.getLastUpdated().toISOString();

      if (targetMap[originId]) {
        const tEvent = targetMap[originId];
        const storedUpdated = tEvent.getTag('origin_updated');
        
        if (storedUpdated !== lastUpdated) {
          if (CONFIG.DRY_RUN) {
            recordLog(`[DRY_RUN] 🔄 更新予定: ${targetTitle} (${formatDate(sStart)})`);
          } else {
            tEvent.deleteEvent();
            createTargetEvent(targetCal, sEvent, targetTitle, originId, lastUpdated, sourceId);
            recordLog(`🔄 更新: ${targetTitle} (${formatDate(sStart)})`);
          }
        }
        delete targetMap[originId];
      } else {
        if (CONFIG.DRY_RUN) {
          recordLog(`[DRY_RUN] ✨ 新規作成予定: ${targetTitle} (${formatDate(sStart)})`);
        } else {
          createTargetEvent(targetCal, sEvent, targetTitle, originId, lastUpdated, sourceId);
          recordLog(`✨ 新規: ${targetTitle} (${formatDate(sStart)})`);
        }
      }
    }
  });

  // --- Delete ---
  for (const key in targetMap) {
    const tEvent = targetMap[key];
    const sourceCalTag = tEvent.getTag('source_calendar_id');
  
    if (sourceCalTag !== sourceId) continue;

    const title = tEvent.getTitle();
    const start = tEvent.getStartTime();
    if (CONFIG.DRY_RUN) {
      recordLog(`[DRY_RUN] 🗑️ 削除予定: ${title} (${formatDate(start)})`);
    } else {
      tEvent.deleteEvent();
      recordLog(`🗑️ 削除: ${title} (${formatDate(start)})`);
    }
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
 * 統合通知ハンドラ (Discord & Google Chat)
 */
function sendNotifications() {
  if (CONFIG.DRY_RUN) {
    console.log("[DRY_RUN] 通知スキップ");
    return;
  }
  
  const message = LOG_BUFFER.join("\n");
  
  // Discordへ送信
  if (CONFIG.DISCORD_WEBHOOK_URL) {
    sendDiscord(message);
  }
  
  // Google Chatへ送信
  if (CONFIG.GOOGLE_CHAT_WEBHOOK_URL) {
    sendGoogleChat(message);
  }
}

/**
 * Discord通知送信
 */
function sendDiscord(message) {
  if (!CONFIG.DISCORD_WEBHOOK_URL) return;
  const payload = {
    content: `📅 **Calendar Sync Report**\n${message}`
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
 * Google Chat通知送信 (新規追加)
 */
function sendGoogleChat(message) {
  if (!CONFIG.GOOGLE_CHAT_WEBHOOK_URL) return;
  const payload = {
    text: `📅 *Calendar Sync Report*\n${message}`
  };

  try {
    UrlFetchApp.fetch(CONFIG.GOOGLE_CHAT_WEBHOOK_URL, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload)
    });
    console.log("Google Chat通知送信完了");
  } catch (e) {
    console.error("Google Chat送信エラー: " + e.toString());
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
    'LIFE_CALENDAR_ID': '',
    'DISCORD_WEBHOOK_URL': '',
    'GOOGLE_CHAT_WEBHOOK_URL': '',
    'SYNC_KEYWORDS_TO_LIFE': '[Life],出張,深夜作業',
		'SYNC_KEYWORDS_TO_WORK': '[Work],通院,役所',
    'MASK_TITLE_LIFE': '休暇',
    'MASK_TITLE_WORK': '仕事',
    'MASK_WORK_TO_LIFE': 'false',
    'SYNC_DAYS': '30',
    'WEEKEND_DAYS': '0,6',
    'HOLIDAY_IGNORE_LIST': '節分,バレンタイン,雛祭り,母の日,父の日,七夕,ハロウィン,クリスマス',
    'CUSTOM_HOLIDAY_KEYWORDS': '',
    'DRY_RUN': 'false'
  };

  for (const [key, val] of Object.entries(defaults)) {
    if (!current[key]) {
      props.setProperty(key, val);
    }
  }
  console.log("プロパティの枠を作成しました。");
}

/**
 * デバッグ用：WORKカレンダーとLIFEカレンダーにアクセスできるかチェック
 */
  
function testAccess() {
  const props = PropertiesService.getScriptProperties().getProperties();
  const workId = props.WORK_CALENDAR_ID;
  const lifeId = props.LIFE_CALENDAR_ID;

  const workCal = CalendarApp.getCalendarById(workId);
  const lifeCal = CalendarApp.getCalendarById(lifeId);

  console.log(`WORK(${workId}): ${workCal ? "OK ✅" : "NG ❌ (見つかりません)"}`);
  console.log(`LIFE(${lifeId}): ${lifeCal ? "OK ✅" : "NG ❌ (見つかりません)"}`);
}
