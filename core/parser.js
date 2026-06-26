/* =========================================================
   CSV 解析層
   對應 core/parser.py

   兩個國泰證券特有的格式重點：
   1. 檔案開頭第一行通常是一段篩選結果的說明文字，不是真正的欄位標題，
      程式會自動往下找含有「買賣別」等關鍵字的那一行，當作真正的標題列。
   2. 這份格式沒有「股票代號」欄位，只有「股名」。所以股票代號欄位設成
      非必要，找不到的話會直接拿股名當代號使用，分組配對邏輯不受影響。

   檔案編碼偵測（Big5 / UTF-8 with BOM）在瀏覽器端由 encoding.js 處理，
   這個模組只負責「已經是字串」之後的 CSV 解析。
   ========================================================= */
(function (global) {
  "use strict";

  // 標準欄位 -> 可能出現的原始欄位名稱（依優先順序比對，找到第一個符合的就採用）
  const COLUMN_ALIASES = {
    stockCode: ["股票代號", "證券代號", "商品代號", "代號"],
    stockName: ["股名", "股票名稱", "證券名稱", "商品名稱", "名稱"],
    tradeDate: ["成交日期", "交易日期", "委託日期", "日期"],
    action: ["買賣別", "買賣", "委託別", "交易別"],
    quantity: ["成交股數", "成交數量", "股數", "數量"],
    price: ["成交價格", "成交價", "單價", "價格"],
    fee: ["手續費"],
    tax: ["交易稅", "證交稅", "稅額"],
    orderId: ["委託書號", "委託編號", "委託序號"],
  };

  // 沒有這個欄位也沒關係，會用 stockName 頂替
  const OPTIONAL_FIELDS = new Set(["stockCode", "orderId"]);

  // 在檔案開頭幾行裡，只要出現這些關鍵字其中之一，就認定那一行是真正的標題列
  const HEADER_CUE_KEYWORDS = ["買賣別", "成交股數", "委託書號"];

  // 買賣別欄位裡，怎樣的文字算「買」、怎樣算「賣」（大小寫敏感，跟原本一致）
  const BUY_KEYWORDS = ["買", "B", "buy"];
  const SELL_KEYWORDS = ["賣", "S", "sell"];

  // ---------- 通用 CSV tokenizer（支援引號欄位、逗號跳脫、欄位內換行）----------

  function tokenizeCSV(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    let i = 0;
    const len = text.length;

    while (i < len) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ",") { row.push(field); field = ""; i++; continue; }
      if (c === "\r") { i++; continue; }
      if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += c; i++;
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return rows.filter((r) => !(r.length === 1 && r[0] === ""));
  }

  function rowsToObjects(header, dataRows) {
    return dataRows.map((raw) => {
      const obj = {};
      header.forEach((h, idx) => { obj[h] = raw[idx] !== undefined ? raw[idx] : ""; });
      return obj;
    });
  }

  // ---------- 標題列偵測（跳過國泰證券對帳單開頭的篩選結果說明文字）----------

  function findHeaderLineIndex(text) {
    const lines = text.split(/\r\n|\r|\n/);
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      if (HEADER_CUE_KEYWORDS.some((k) => lines[i].includes(k))) return i;
    }
    return 0; // 找不到明顯標題列的話，假設第一行就是
  }

  // ---------- 欄位對應 ----------

  function detectColumnMap(fieldnames) {
    const mapping = {};
    const missing = [];
    for (const standardField of Object.keys(COLUMN_ALIASES)) {
      const aliases = COLUMN_ALIASES[standardField];
      let found = null;
      for (const alias of aliases) {
        for (const col of fieldnames) {
          if (col.includes(alias)) { found = col; break; }
        }
        if (found) break;
      }
      if (found) {
        mapping[standardField] = found;
      } else if (!OPTIONAL_FIELDS.has(standardField)) {
        missing.push(standardField);
      }
    }
    if (missing.length) {
      throw new Error(
        "找不到下列欄位，請對照實際 CSV 標題列確認格式：\n" +
        `  缺少：${missing.join("、")}\n` +
        `  目前 CSV 的欄位名稱有：${fieldnames.join("、")}`
      );
    }
    return mapping;
  }

  function parseAction(raw) {
    const s = String(raw).trim();
    if (BUY_KEYWORDS.some((k) => s.includes(k))) return "buy";
    if (SELL_KEYWORDS.some((k) => s.includes(k))) return "sell";
    throw new Error(`無法辨識的買賣別：${raw}`);
  }

  function toNumber(raw) {
    if (raw === null || raw === undefined) return 0.0;
    const cleaned = String(raw).replace(/,/g, "").replace(/\$/g, "").trim();
    if (cleaned === "" || cleaned === "-") return 0.0;
    const n = Number(cleaned);
    if (Number.isNaN(n)) throw new Error(`無法解析的數字：${raw}`);
    return n;
  }

  // ---------- 主要進入點 ----------

  // text：已經解碼成字串的 CSV 內容（編碼偵測在呼叫端的 encoding.js 完成）
  function parseCsvText(text) {
    const headerIdx = findHeaderLineIndex(text);
    const lines = text.split(/\r\n|\r|\n/);
    const csvText = lines.slice(headerIdx).join("\n");

    const rawRows = tokenizeCSV(csvText);
    if (!rawRows.length) throw new Error("CSV 是空的，或是讀不到任何資料列");

    const header = rawRows[0];
    const rows = rowsToObjects(header, rawRows.slice(1));
    if (!rows.length) throw new Error("CSV 是空的，或是讀不到任何資料列");

    const columnMap = detectColumnMap(header);

    const transactions = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const stockName = String(row[columnMap.stockName] ?? "").trim();
        const stockCode = columnMap.stockCode
          ? String(row[columnMap.stockCode] ?? "").trim()
          : stockName;
        const orderId = columnMap.orderId
          ? String(row[columnMap.orderId] ?? "").trim()
          : "";
        const tradeDate = DateUtil.parseFlexible(row[columnMap.tradeDate]);
        const action = parseAction(row[columnMap.action]);
        const quantity = Math.trunc(toNumber(row[columnMap.quantity]));
        const price = toNumber(row[columnMap.price]);
        const fee = toNumber(row[columnMap.fee]);
        const tax = toNumber(row[columnMap.tax]);

        if (quantity <= 0) continue; // 跳過數量為 0 的列（有些對帳單會有空白列或合計列）

        transactions.push(new Models.Transaction({
          stockCode, stockName, tradeDate, action, quantity, price, fee, tax,
          seq: i, orderId,
        }));
      } catch (e) {
        throw new Error(`第 ${i + 2} 列解析失敗（CSV 含標題列，所以從第 2 列起算）：${e.message}`);
      }
    }
    return transactions;
  }

  // 合併多份 CSV 解析出來的交易清單，並且自動去除重複交易。
  // 用「委託書號 + 成交日期」當作辨識重複的依據；沒有委託書號的話，
  // 退而求其次用「日期、股票、買賣別、股數、價格、手續費、交易稅」這組合。
  function mergeTransactions(transactionLists) {
    const seen = new Set();
    const merged = [];
    let duplicateCount = 0;

    for (const txList of transactionLists) {
      for (const t of txList) {
        const key = t.orderId
          ? `order|${t.tradeDate}|${t.orderId}`
          : `fallback|${t.tradeDate}|${t.stockCode}|${t.action}|${t.quantity}|${t.price}|${t.fee}|${t.tax}`;

        if (seen.has(key)) { duplicateCount++; continue; }
        seen.add(key);
        merged.push(t);
      }
    }

    // 重新編號 seq，確保跨檔案合併後，同一天的交易排序穩定
    merged.sort((a, b) => (a.tradeDate - b.tradeDate) || (a.seq - b.seq));
    merged.forEach((t, i) => { t.seq = i; });

    return { transactions: merged, duplicateCount };
  }

  global.Parser = {
    parseCsvText, mergeTransactions, tokenizeCSV, detectColumnMap,
    findHeaderLineIndex, toNumber,
  };
})(typeof window !== "undefined" ? window : global);
