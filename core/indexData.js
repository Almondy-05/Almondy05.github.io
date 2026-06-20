/* =========================================================
   大盤指數（台灣加權指數 TAIEX）資料來源層
   對應 core/index_data.py

   桌面版用 Python 的 urllib 連線到證交所，瀏覽器版改用 fetch()。
   兩者最大的差異：瀏覽器有同源政策（CORS），如果證交所這支端點沒有
   主動開放跨來源請求，fetch 會直接被瀏覽器擋下，JS 端只會看到一個
   籠統的網路錯誤，看不到實際的 HTTP 狀態碼或回應內容（這是瀏覽器
   的安全機制，不是程式寫錯）。設計上維持桌面版「能抓就抓，抓不到就
   跳過」的精神：第一次嘗試失敗就直接判定連不到，不會逐一嘗試浪費
   使用者時間，並且清楚告知可以改用「上傳大盤指數 CSV」這個一定能用
   的替代方案。

   本機快取：桌面版存在 %APPDATA%/TradeAnalyzer/index_cache.json，
   瀏覽器版改存在 localStorage（同一個瀏覽器、同一個網址下次打開還在；
   如果是直接用 file:// 開啟本機 HTML 檔案，快取會綁定在瀏覽器對該
   檔案路徑的儲存空間，清瀏覽器資料或關閉無痕模式會清掉，這點跟桌面版
   略有不同）。
   ========================================================= */
(function (global) {
  "use strict";

  const TWSE_MI_INDEX_URL = "https://www.twse.com.tw/exchangeReport/MI_INDEX";
  const TAIEX_ROW_LABEL = "發行量加權股價指數";
  const REQUEST_TIMEOUT_MS = 6000;

  // 上傳 CSV 裡，只要標題列出現這個字，就認定那一行是真正的欄位標題
  const INDEX_CSV_HEADER_CUE = "收盤指數";

  // 計算「漲跌百分比」的時候，前一筆資料跟現在這筆日期間隔超過這個天數，
  // 就不認定為「前一個交易日」，寧可顯示沒有資料也不要算出橫跨好幾天的
  // 錯誤數字。10 天足以涵蓋台股一般國定連假，只有春節封關會被擋下。
  const MAX_GAP_DAYS = 10;

  const CACHE_STORAGE_KEY = "tradeAnalyzer.indexCache.v1";

  class NetworkUnavailable extends Error {}

  function toNumber(raw) {
    if (raw === null || raw === undefined) return 0.0;
    const cleaned = String(raw).replace(/,/g, "").trim();
    if (cleaned === "" || cleaned === "-" || cleaned === "--") return 0.0;
    const n = Number(cleaned);
    return Number.isNaN(n) ? 0.0 : n;
  }

  // ---------- 主動連網抓取（瀏覽器 fetch，會受 CORS 限制）----------

  function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
  }

  async function fetchIndexTables(targetDateEpoch) {
    const { y, m, d } = DateUtil.intToYMD(targetDateEpoch);
    const dateStr = `${y}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`;
    const url = `${TWSE_MI_INDEX_URL}?response=json&date=${dateStr}&type=ALL`;

    let resp;
    try {
      resp = await fetchWithTimeout(url, { mode: "cors", cache: "no-store" }, REQUEST_TIMEOUT_MS);
    } catch (e) {
      // fetch 對 CORS 被擋、離線、逾時等情況一律丟出籠統的 TypeError /
      // AbortError，沒辦法區分原因，統一視為「連不到」
      throw new NetworkUnavailable(
        e.name === "AbortError" ? "連線逾時" : `連線失敗（可能是瀏覽器的 CORS 限制擋下跨來源請求）：${e.message}`
      );
    }
    if (!resp.ok) {
      throw new NetworkUnavailable(`伺服器回應異常狀態碼：${resp.status}`);
    }
    let payload;
    try {
      payload = await resp.json();
    } catch (e) {
      throw new NetworkUnavailable(`回應格式無法解析：${e.message}`);
    }
    return payload.tables || [];
  }

  function parseDirection(rawDir) {
    const s = String(rawDir);
    if (s.includes("color:red") || s.includes("color: red")) return 1;
    if (s.includes("color:green") || s.includes("color: green")) return -1;
    if (s.includes("X")) return null;
    return 0;
  }

  // 查某一天的大盤收盤指數跟漲跌百分比。查得到回傳 {"收盤指數":...,"漲跌百分比":...}；
  // 遇到假日、還沒開盤、那天查不到資料這幾種正常情況，回傳 null。
  // 連線本身失敗（CORS、離線、逾時）會丟出 NetworkUnavailable。
  async function fetchTaiexDaily(targetDateEpoch) {
    const tables = await fetchIndexTables(targetDateEpoch);
    for (const table of tables) {
      const fields = table.fields || [];
      if (!fields.includes("指數") || !fields.includes("收盤指數")) continue;
      const idxCol = fields.indexOf("指數");
      const closeCol = fields.indexOf("收盤指數");
      const pctCol = fields.includes("漲跌百分比(%)") ? fields.indexOf("漲跌百分比(%)") : -1;
      const dirCol = fields.includes("漲跌(+/-)") ? fields.indexOf("漲跌(+/-)") : -1;

      for (const row of table.data || []) {
        if (!(row.length > Math.max(idxCol, closeCol) && row[idxCol] === TAIEX_ROW_LABEL)) continue;
        const close = toNumber(row[closeCol]);
        let pct = null;
        if (pctCol >= 0 && row.length > pctCol) {
          const direction = dirCol >= 0 && row.length > dirCol ? parseDirection(row[dirCol]) : 0;
          if (direction !== null) {
            const magnitude = Math.abs(toNumber(row[pctCol]));
            pct = NumberUtil.pyRound(magnitude * direction, 2);
          }
        }
        return { "收盤指數": close, "漲跌百分比": pct };
      }
    }
    return null;
  }

  async function fetchTaiexClose(targetDateEpoch) {
    const info = await fetchTaiexDaily(targetDateEpoch);
    return info ? info["收盤指數"] : null;
  }

  // 針對一批日期逐天查詢。第一次連線失敗就視為沒有網路，直接停止。
  // progressCallback(done, total) 每查完一天呼叫一次，用來顯示進度。
  // 回傳 {result, errorMessage}
  async function fetchTaiexRange(dates, progressCallback) {
    const result = {};
    let errorMessage = null;
    const sortedDates = [...new Set(dates)].sort((a, b) => a - b);
    const total = sortedDates.length;

    for (let i = 0; i < sortedDates.length; i++) {
      const d = sortedDates[i];
      let info;
      try {
        info = await fetchTaiexDaily(d);
      } catch (e) {
        errorMessage = e.message;
        break;
      }
      if (info !== null) result[d] = info;
      if (progressCallback) {
        try { progressCallback(i + 1, total); } catch (e) { /* 進度回報失敗不影響抓取 */ }
      }
    }
    return { result, errorMessage };
  }

  // 手動測試一次連線：從今天開始往回找最近 10 天裡第一個查得到資料的交易日
  async function checkTaiexConnection() {
    const today = DateUtil.todayInt();
    for (let offset = 0; offset < 10; offset++) {
      const d = today - offset;
      let close;
      try {
        close = await fetchTaiexClose(d);
      } catch (e) {
        return { ok: false, message: e.message, testedDate: DateUtil.toISO(d) };
      }
      if (close !== null) {
        return { ok: true, message: `${DateUtil.toISO(d)} 收盤指數 ${close}`, testedDate: DateUtil.toISO(d) };
      }
    }
    return {
      ok: false,
      message: "連線本身沒有報錯，但最近 10 天都查不到資料，可能是日期或回應格式的問題",
      testedDate: DateUtil.toISO(today),
    };
  }

  // ---------- 手動上傳 CSV ----------

  // text：已解碼成字串的大盤指數歷史資料 CSV 內容
  function parseIndexCsvText(text) {
    const lines = text.split(/\r\n|\r|\n/);
    let headerIdx = 0;
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      if (lines[i].includes(INDEX_CSV_HEADER_CUE)) { headerIdx = i; break; }
    }
    const csvText = lines.slice(headerIdx).join("\n");
    const rawRows = Parser.tokenizeCSV(csvText);
    const result = {};
    if (!rawRows.length) return result;

    const header = rawRows[0];
    const dateCol = header.find((h) => h && h.includes("日期"));
    const closeCol = header.find((h) => h && h.includes(INDEX_CSV_HEADER_CUE));
    if (!dateCol || !closeCol) return result;
    const dateIdx = header.indexOf(dateCol);
    const closeIdx = header.indexOf(closeCol);

    for (const row of rawRows.slice(1)) {
      const rawDate = (row[dateIdx] || "").trim();
      const rawClose = (row[closeIdx] || "").trim();
      if (!rawDate || !rawClose) continue;
      let d;
      try { d = DateUtil.parseROC(rawDate); } catch (e) { continue; }
      const close = toNumber(rawClose);
      if (close > 0) result[d] = close;
    }
    return result;
  }

  // 合併多份大盤指數 CSV（例如分月下載的好幾個檔案），同一天重複出現就用後面蓋過去
  function parseIndexCsvTexts(texts) {
    const merged = {};
    for (const text of texts) Object.assign(merged, parseIndexCsvText(text));
    return merged;
  }

  // ---------- 統一快取格式：合併資料 + 算出每日漲跌百分比 ----------

  // official_pct 有值的話（連網抓到的）會直接覆蓋；沒有給的話（上傳 CSV 來的），
  // 保留原本已經有的官方百分比，避免重新上傳同一個月份的 CSV 把比較準確的
  // 官方數字洗掉。
  function mergeCloseIntoCache(cache, d, close, officialPct = null) {
    const entry = { "收盤指數": close };
    if (officialPct !== null && officialPct !== undefined) {
      entry["官方漲跌百分比"] = officialPct;
    } else {
      const existing = cache[d];
      if (existing && existing["官方漲跌百分比"] !== undefined && existing["官方漲跌百分比"] !== null) {
        entry["官方漲跌百分比"] = existing["官方漲跌百分比"];
      }
    }
    cache[d] = entry;
  }

  function mergeFetchedIntoCache(cache, fetched) {
    for (const dStr of Object.keys(fetched)) {
      const d = Number(dStr);
      const info = fetched[d];
      mergeCloseIntoCache(cache, d, info["收盤指數"], info["漲跌百分比"]);
    }
  }

  function mergeCsvIntoCache(cache, closes) {
    for (const dStr of Object.keys(closes)) {
      const d = Number(dStr);
      mergeCloseIntoCache(cache, d, closes[d]);
    }
  }

  // 從快取算出每個日期最終的 {"收盤指數":...,"漲跌百分比":...}
  function buildDailyChangeMap(cache) {
    const orderedDates = Object.keys(cache).map(Number).sort((a, b) => a - b);
    const result = {};
    let prevDate = null;
    let prevClose = null;
    for (const d of orderedDates) {
      const close = cache[d]["收盤指數"];
      const officialPct = cache[d]["官方漲跌百分比"];

      let pct;
      if (officialPct !== undefined && officialPct !== null) {
        pct = officialPct;
      } else if (prevClose && prevDate !== null && (d - prevDate) <= MAX_GAP_DAYS) {
        pct = NumberUtil.pyRound(((close - prevClose) / prevClose) * 100, 2);
      } else {
        pct = null;
      }

      result[d] = { "收盤指數": close, "漲跌百分比": pct };
      prevDate = d;
      prevClose = close;
    }
    return result;
  }

  // ---------- 本機快取：用 localStorage 取代桌面版的 %APPDATA% 檔案 ----------

  function hasLocalStorage() {
    try {
      return typeof localStorage !== "undefined";
    } catch (e) {
      return false;
    }
  }

  function loadIndexCache() {
    if (!hasLocalStorage()) return {};
    try {
      const raw = localStorage.getItem(CACHE_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      const result = {};
      for (const k of Object.keys(parsed)) result[Number(k)] = parsed[k];
      return result;
    } catch (e) {
      return {};
    }
  }

  function saveIndexCache(cache) {
    if (!hasLocalStorage()) return;
    try {
      localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(cache));
    } catch (e) {
      // 存檔失敗（例如容量爆掉）不該讓分析流程整個失敗，安靜略過就好
    }
  }

  global.IndexData = {
    NetworkUnavailable,
    fetchTaiexDaily, fetchTaiexClose, fetchTaiexRange, checkTaiexConnection,
    parseIndexCsvText, parseIndexCsvTexts,
    mergeCloseIntoCache, mergeFetchedIntoCache, mergeCsvIntoCache,
    buildDailyChangeMap,
    loadIndexCache, saveIndexCache,
    MAX_GAP_DAYS,
  };
})(typeof window !== "undefined" ? window : global);
