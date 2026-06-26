/* =========================================================
   大盤指數（台灣加權指數 TAIEX）資料來源層
   對應 core/index_data.py（2026/06 改版後版本）

   兩種取得資料的方式：

   1. 主動連網抓取（手動觸發，不會自動連網）
      批次抓取（fetchTaiexRange）用「整月」為單位的端點 MI_5MINS_HIST，一次
      回傳一整個月的大盤收盤指數，把需要的日期按年月分組之後一個月份只打一次
      請求。這支端點跟「上傳大盤指數 CSV」背後是同一份資料，只是這裡直接連網
      拿 JSON。另外 fetchTaiexClose 用逐日查詢的端點 MI_INDEX（一次一天、回傳
      當天全市場所有指數），只給「測試大盤連線」這種輕量單日測試用。

      瀏覽器有同源政策（CORS）。桌面版用 Python urllib 沒有這個限制，瀏覽器版
      改用 fetch()，能不能成功取決於證交所這兩支端點有沒有對跨來源請求回應
      適當的標頭。連不到的話一律走「上傳大盤指數 CSV」這個一定能用的路徑。

   2. 手動上傳 CSV（證交所「發行量加權股價指數歷史資料」頁面下載）

   漲跌百分比一律用「相鄰兩筆」計算（buildDailyChangeMap），不管收盤指數是
   連網抓的還是上傳 CSV 來的都走同一套算法。早期版本曾經讓連網抓到的日期
   直接採用證交所官方漲跌百分比、上傳 CSV 的才用相鄰兩筆推算，兩種算法理論上
   該算出同一個答案，實際上有捨入精度差異；同一份分析裡混到兩種來源時，
   大盤基準會兜不起來。統一成一套算法之後，不管資料怎麼混合，結果都一致。

   本機快取存在 localStorage。
   ========================================================= */
(function (global) {
  "use strict";

  const TWSE_MI_INDEX_URL = "https://www.twse.com.tw/exchangeReport/MI_INDEX";
  const TWSE_MI_5MINS_HIST_URL = "https://www.twse.com.tw/indicesReport/MI_5MINS_HIST";
  const TAIEX_ROW_LABEL = "發行量加權股價指數";
  const REQUEST_TIMEOUT_MS = 8000;

  const INDEX_CSV_HEADER_CUE = "收盤指數";

  // 計算漲跌百分比時，前一筆資料跟現在這筆間隔超過這個天數，就不認定為「前一個
  // 交易日」，回傳 null，不硬算出橫跨好幾天卻被誤認成「單日漲跌」的錯誤數字。
  // 10 天足以涵蓋台股一般國定連假，只有春節封關會被擋下。
  const MAX_GAP_DAYS = 10;

  const CACHE_STORAGE_KEY = "tradeAnalyzer.indexCache.v2";

  class NetworkUnavailable extends Error {}

  function toNumber(raw) {
    if (raw === null || raw === undefined) return 0.0;
    const cleaned = String(raw).replace(/,/g, "").trim();
    if (cleaned === "" || cleaned === "-" || cleaned === "--") return 0.0;
    const n = Number(cleaned);
    return Number.isNaN(n) ? 0.0 : n;
  }

  // ---------- 主動連網抓取（瀏覽器 fetch，會受 CORS 限制）----------

  const BROWSER_HEADERS = {
    "Accept": "application/json, text/plain, */*",
  };

  function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
  }

  async function fetchJson(url) {
    let resp;
    try {
      resp = await fetchWithTimeout(url, { mode: "cors", cache: "no-store", headers: BROWSER_HEADERS }, REQUEST_TIMEOUT_MS);
    } catch (e) {
      throw new NetworkUnavailable(
        e.name === "AbortError" ? "連線逾時"
          : `連線失敗（可能是瀏覽器的 CORS 限制擋下跨來源請求）：${e.message}`
      );
    }
    if (!resp.ok) throw new NetworkUnavailable(`伺服器回應異常狀態碼：${resp.status}`);
    try {
      return await resp.json();
    } catch (e) {
      throw new NetworkUnavailable(`回應格式無法解析：${e.message}`);
    }
  }

  // 逐日端點：查某一天的大盤收盤指數，給 checkTaiexConnection 這種輕量單日測試用，
  // 不用在批次抓取上（批次改用整月端點 fetchTaiexMonth，快很多）。查得到回傳
  // 收盤指數；遇到假日、還沒開盤、那天查不到資料這幾種正常情況，回傳 null。
  async function fetchTaiexClose(targetDateEpoch) {
    const { y, m, d } = DateUtil.intToYMD(targetDateEpoch);
    const dateStr = `${y}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`;
    const url = `${TWSE_MI_INDEX_URL}?response=json&date=${dateStr}&type=ALL`;
    const payload = await fetchJson(url);
    const tables = payload.tables || [];
    for (const table of tables) {
      const fields = table.fields || [];
      if (!fields.includes("指數") || !fields.includes("收盤指數")) continue;
      const idxCol = fields.indexOf("指數");
      const closeCol = fields.indexOf("收盤指數");
      for (const row of table.data || []) {
        if (row.length > Math.max(idxCol, closeCol) && row[idxCol] === TAIEX_ROW_LABEL) {
          return toNumber(row[closeCol]);
        }
      }
    }
    return null;
  }

  // 整月端點：一次抓一整個月的大盤收盤指數（跟「上傳大盤指數 CSV」對應同一份
  // 資料）。日期參數只有年月有作用，固定傳每個月 1 號。回傳的資料只有開高低收，
  // 沒有官方漲跌百分比，漲跌交給 buildDailyChangeMap 用相鄰兩筆去算 —— 整月端點
  // 一次回傳整月連續交易日，相鄰兩筆一定是真正相鄰的交易日，算出來是準的。
  // 回傳 {epochDay: close}。查不到資料回傳空物件；連線失敗丟 NetworkUnavailable。
  async function fetchTaiexMonth(year, month) {
    const dateStr = `${year}${String(month).padStart(2, "0")}01`;
    const url = `${TWSE_MI_5MINS_HIST_URL}?response=json&date=${dateStr}`;
    const payload = await fetchJson(url);
    const result = {};
    for (const row of payload.data || []) {
      if (row.length < 5) continue;
      let d;
      try { d = DateUtil.parseROC(String(row[0])); } catch (e) { continue; }
      const close = toNumber(row[4]);
      if (close > 0) result[d] = close;
    }
    return result;
  }

  // 批次抓取：按年月分組，一個月份只打一次整月端點。第一個月份就連線失敗就視為
  // 沒有網路、直接停止。progressCallback(done, total) 每抓完一個月份呼叫一次。
  // 回傳 {result: {epochDay: close}, errorMessage}，跟上傳 CSV 解析格式一致，
  // 方便用同一個 merge 函式併入快取。
  async function fetchTaiexRange(dates, progressCallback) {
    const result = {};
    let errorMessage = null;

    const monthSet = new Set();
    for (const d of dates) {
      const { y, m } = DateUtil.intToYMD(d);
      monthSet.add(`${y}-${m}`);
    }
    const months = [...monthSet].map((s) => s.split("-").map(Number)).sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    const total = months.length;

    for (let i = 0; i < months.length; i++) {
      const [y, m] = months[i];
      let monthCloses;
      try {
        monthCloses = await fetchTaiexMonth(y, m);
      } catch (e) {
        errorMessage = e.message;
        break;
      }
      Object.assign(result, monthCloses);
      if (progressCallback) {
        try { progressCallback(i + 1, total); } catch (e) { /* 進度回報失敗不影響抓取 */ }
      }
    }
    return { result, errorMessage };
  }

  // 手動測試連線：從今天往回找最近 10 天裡第一個查得到資料的交易日
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

  function parseIndexCsvTexts(texts) {
    const merged = {};
    for (const text of texts) Object.assign(merged, parseIndexCsvText(text));
    return merged;
  }

  // ---------- 快取合併 + 算出每日漲跌百分比 ----------
  // 快取格式統一成 {epochDay: {"收盤指數": ...}}，不管收盤指數是連網抓的還是
  // 上傳 CSV 來的，存進快取的格式完全一樣。

  function mergeCloseIntoCache(cache, d, close) {
    cache[d] = { "收盤指數": close };
  }

  function mergeFetchedIntoCache(cache, fetched) {
    for (const dStr of Object.keys(fetched)) mergeCloseIntoCache(cache, Number(dStr), fetched[dStr]);
  }

  function mergeCsvIntoCache(cache, closes) {
    for (const dStr of Object.keys(closes)) mergeCloseIntoCache(cache, Number(dStr), closes[dStr]);
  }

  // 從快取算出每個日期最終的 {"收盤指數":..., "漲跌百分比":...}：往前找快取裡最近
  // 一筆有資料的日期，間隔在 MAX_GAP_DAYS 天以內才採用算出來的百分比，間隔太大
  // （可能中間缺資料）就回傳 null。不管資料來源是什麼，一律用這套「相鄰兩筆」算法。
  function buildDailyChangeMap(cache) {
    const orderedDates = Object.keys(cache).map(Number).sort((a, b) => a - b);
    const result = {};
    let prevDate = null;
    let prevClose = null;
    for (const d of orderedDates) {
      const close = cache[d]["收盤指數"];
      let pct;
      if (prevClose && prevDate !== null && (d - prevDate) <= MAX_GAP_DAYS) {
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

  // ---------- 本機快取：localStorage ----------

  function hasLocalStorage() {
    try { return typeof localStorage !== "undefined"; } catch (e) { return false; }
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
      // 存檔失敗（容量爆掉等）不該讓分析流程整個失敗
    }
  }

  function clearIndexCache(cache) {
    for (const k of Object.keys(cache)) delete cache[k];
    if (hasLocalStorage()) {
      try { localStorage.removeItem(CACHE_STORAGE_KEY); } catch (e) { /* ignore */ }
    }
  }

  global.IndexData = {
    NetworkUnavailable,
    fetchTaiexClose, fetchTaiexMonth, fetchTaiexRange, checkTaiexConnection,
    parseIndexCsvText, parseIndexCsvTexts,
    mergeCloseIntoCache, mergeFetchedIntoCache, mergeCsvIntoCache,
    buildDailyChangeMap,
    loadIndexCache, saveIndexCache, clearIndexCache,
    MAX_GAP_DAYS,
  };
})(typeof window !== "undefined" ? window : global);
