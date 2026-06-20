/* =========================================================
   日期工具

   所有「日期」在整個程式裡都用一個整數表示：從 1970-01-01 算起的
   天數（epoch day，用 Date.UTC 計算，完全不受使用者瀏覽器時區、
   日光節約時間影響）。這個整數可以直接相減得到天數差，行為
   對應 Python 的 date 物件（純日曆日期，沒有時區）。

   外部需要顯示或比較的地方，用 toISO() 轉成 "YYYY-MM-DD" 字串。
   ========================================================= */
(function (global) {
  "use strict";

  function ymdToInt(y, m, d) {
    // m 是 1-12（跟一般人類認知一致，不是 JS Date 的 0-11）
    return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  }

  function intToYMD(epochDay) {
    const ms = epochDay * 86400000;
    const dt = new Date(ms);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function toISO(epochDay) {
    const { y, m, d } = intToYMD(epochDay);
    return `${y}-${pad2(m)}-${pad2(d)}`;
  }

  function monthKey(epochDay) {
    const { y, m } = intToYMD(epochDay);
    return `${y}-${pad2(m)}`;
  }

  function addDays(epochDay, n) {
    return epochDay + n;
  }

  function diffDays(later, earlier) {
    return later - earlier;
  }

  function todayInt() {
    const now = new Date();
    return ymdToInt(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }

  // 對應 parser.py 的 _parse_date：支援 YYYYMMDD / YYYY-MM-DD / YYYY/MM/DD /
  // YYMMDD / YYYY.MM.DD 幾種常見格式
  function parseFlexible(raw) {
    const s = String(raw).trim();

    let m = s.match(/^(\d{4})(\d{2})(\d{2})$/); // YYYYMMDD
    if (m) return ymdToInt(+m[1], +m[2], +m[3]);

    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); // YYYY-MM-DD
    if (m) return ymdToInt(+m[1], +m[2], +m[3]);

    m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/); // YYYY/MM/DD
    if (m) return ymdToInt(+m[1], +m[2], +m[3]);

    m = s.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})$/); // YYYY.MM.DD
    if (m) return ymdToInt(+m[1], +m[2], +m[3]);

    m = s.match(/^(\d{2})(\d{2})(\d{2})$/); // YYMMDD（西元年 2000+ 起算）
    if (m) return ymdToInt(2000 + (+m[1]), +m[2], +m[3]);

    throw new Error(`無法辨識的日期格式：${raw}`);
  }

  // 對應 index_data.py 的 _parse_roc_date：民國年，例如 115/06/19 -> 2026-06-19，
  // 也相容西元年格式跟用「-」分隔的寫法
  function parseROC(raw) {
    const s = String(raw).trim().replace(/-/g, "/");
    const parts = s.split("/");
    if (parts.length !== 3) throw new Error(`無法辨識的日期格式：${raw}`);
    let [y, mo, d] = parts.map((p) => parseInt(p, 10));
    if (y < 1911) y += 1911;
    return ymdToInt(y, mo, d);
  }

  const DateUtil = {
    ymdToInt, intToYMD, toISO, monthKey, addDays, diffDays, todayInt,
    parseFlexible, parseROC,
  };

  global.DateUtil = DateUtil;
})(typeof window !== "undefined" ? window : global);
