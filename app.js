/* =========================================================
   前端主程式（瀏覽器版）

   跟桌面版最大的差異：原本由 Python（main.py）透過 eel 處理的檔案選擇、
   分析流程協調、大盤資料抓取，現在全部搬進這支檔案，直接呼叫同一批
   核心模組（Parser / Matcher / Capital / Stats / IndexData）。
   圖表繪製（canvas 手繪、滑鼠 hover）邏輯跟桌面版完全相同，沒有改動。
   ========================================================= */

const pickBtn = document.getElementById("pickBtn");
const csvFileInput = document.getElementById("csvFileInput");
const emptyState = document.getElementById("emptyState");
const resultArea = document.getElementById("resultArea");
const indexPickBtn = document.getElementById("indexPickBtn");
const indexFileInput = document.getElementById("indexFileInput");
const indexFileTag = document.getElementById("indexFileTag");
const testConnectionBtn = document.getElementById("testConnectionBtn");
const fetchMissingBtn = document.getElementById("fetchMissingBtn");
const clearIndexCacheBtn = document.getElementById("clearIndexCacheBtn");

// 大盤指數收盤資料快取，整個分頁存活期間共用：上傳過的 CSV 解析結果跟
// 連網抓過的資料都存在這裡。頁面一打開就讀回上次存在 localStorage 的內容；
// 每次更新都立刻存回去。
let indexCloseCache = IndexData.loadIndexCache();

(function showInitialIndexCacheStatus() {
  const dates = Object.keys(indexCloseCache).map(Number);
  if (dates.length) {
    dates.sort((a, b) => a - b);
    indexFileTag.textContent =
      `大盤資料已載入 ${DateUtil.toISO(dates[0])} → ${DateUtil.toISO(dates[dates.length - 1])}（共 ${dates.length} 天）`;
  }
})();

function fmt(n, opts = {}) {
  if (n === null || n === undefined) return "—";
  const sign = opts.showSign && n > 0 ? "+" : "";
  return sign + Number(n).toLocaleString("zh-Hant-TW", {
    maximumFractionDigits: opts.decimals ?? 0,
    minimumFractionDigits: opts.decimals ?? 0,
  });
}

function gainLossClass(n) {
  if (n > 0) return "gain";
  if (n < 0) return "loss";
  return "neutral";
}

function statCell(label, value, cls = "neutral", sub = "") {
  return `
    <div class="stat-cell">
      <div class="label">${label}</div>
      <div class="value ${cls}">${value}</div>
      ${sub ? `<div class="sub">${sub}</div>` : ""}
    </div>
  `;
}

/* =========================================================
   選擇對帳單 CSV 並分析

   抓取大盤資料改成手動觸發（對齊最新桌面版）：分析永遠只讀取目前快取裡
   已經有的大盤資料，不會自動連網。缺漏的日期記在 _lastMissingDates，
   使用者按「立即抓取大盤資料」才會真的連網補齊。
   ========================================================= */

// 記住最近一次成功分析的狀態，給「立即抓取大盤資料」「清除大盤快取」按鈕用：
// 抓完／清完之後可以直接用同一批交易重新整理畫面，不用使用者重新選一次檔案。
let _lastAnalysis = null; // { transactions, matched, openPositions, filenames, duplicateCount }
let _lastMissingDates = [];

pickBtn.addEventListener("click", () => {
  csvFileInput.value = ""; // 確保選同一批檔案也會觸發 change
  csvFileInput.click();
});

csvFileInput.addEventListener("change", async () => {
  const files = Array.from(csvFileInput.files || []);
  if (!files.length) return;

  pickBtn.disabled = true;
  pickBtn.textContent = "分析中…";
  try {
    const data = await analyzeFiles(files);
    if (data.error) {
      alert("分析失敗：\n\n" + data.error);
      return;
    }
    renderResult(data);
  } catch (err) {
    alert("分析失敗：" + (err && err.message ? err.message : err));
    console.error(err);
  } finally {
    pickBtn.disabled = false;
    pickBtn.textContent = "選擇 CSV 並分析（可多選）";
  }
});

async function analyzeFiles(files) {
  try {
    const allTransactions = [];
    for (const file of files) {
      const text = await Encoding.decodeFileText(file);
      allTransactions.push(Parser.parseCsvText(text));
    }
    const mergeResult = Parser.mergeTransactions(allTransactions);
    const transactions = mergeResult.transactions;
    const duplicateCount = mergeResult.duplicateCount;

    const { matchedTrades: matched, openPositions } = Matcher.matchTrades(transactions);

    if (!matched.length) {
      return { error: "這些對帳單沒有配對出任何完整交易（可能全部都是還沒平倉的庫存）" };
    }

    _lastAnalysis = {
      transactions, matched, openPositions,
      filenames: files.map((f) => f.name),
      duplicateCount,
    };

    return buildAnalysisPayload();
  } catch (e) {
    console.error(e);
    return { error: e && e.message ? e.message : String(e) };
  }
}

// 用 _lastAnalysis 記住的交易，搭配目前快取裡的大盤資料，算出完整的畫面資料。
// 分析、上傳 CSV、手動抓取、清除快取都共用這個函式，確保畫面格式一致。
// 只讀快取，不連網；順便把缺漏的大盤日期記到 _lastMissingDates。
function buildAnalysisPayload() {
  const { transactions, matched, openPositions, filenames, duplicateCount } = _lastAnalysis;
  const cleanTrades = matched.filter((m) => !m.isSuspectWindow);

  // 需要哪些大盤日期：每筆交易的進出場日，加上賣飛指標的展望天數、乖離率的
  // 回看天數。缺漏的記下來給「立即抓取大盤資料」按鈕用。
  const coreDatesSet = new Set();
  cleanTrades.forEach((m) => { coreDatesSet.add(m.entryDate); coreDatesSet.add(m.exitDate); });
  const extraDatesSet = new Set();
  cleanTrades.forEach((m) => {
    Stats.sellTooEarlyLookaheadDates(m.exitDate).forEach((d) => extraDatesSet.add(d));
    Stats.biasLookbackDates(m.entryDate).forEach((d) => extraDatesSet.add(d));
    Stats.biasLookbackDates(m.exitDate).forEach((d) => extraDatesSet.add(d));
  });
  const neededDates = [...new Set([...coreDatesSet, ...extraDatesSet])].sort((a, b) => a - b);
  _lastMissingDates = neededDates.filter((d) => !(d in indexCloseCache));

  const indexChangeMap = Object.keys(indexCloseCache).length
    ? IndexData.buildDailyChangeMap(indexCloseCache) : {};

  let coveredCount = 0;
  coreDatesSet.forEach((d) => { if (indexChangeMap[d]) coveredCount++; });

  const indexCoverage = {
    "需要天數": coreDatesSet.size,
    "已涵蓋天數": coveredCount,
    "缺漏天數": coreDatesSet.size - coveredCount,
  };

  const summary = Stats.buildSummary(transactions, matched);
  const rows = Stats.tradesToRows(matched, indexChangeMap);
  const symbolRows = Stats.buildSymbolSummary(matched);
  const bestEfficiencyRows = Stats.findBestEfficiencyStocks(symbolRows);
  const openPositionRows = Stats.buildOpenPositionsRows(openPositions);
  const capitalSeriesRaw = Capital.dailyCapitalSeries(cleanTrades);
  const capitalRows = Stats.capitalBreakdownToRows(
    Capital.dailyCapitalBreakdown(cleanTrades, summary["平均持有天數"])
  );
  const monthlyRows = Stats.buildMonthlySummary(matched);
  const indexCorrelation = Stats.buildIndexCorrelationSummary(matched, indexChangeMap);
  const benchmarkCurve = Stats.buildBenchmarkCurve(matched, capitalSeriesRaw, indexChangeMap);

  return {
    filenames,
    duplicate_count: duplicateCount,
    raw_transaction_count: transactions.length,
    summary,
    trades: rows,
    symbol_summary: symbolRows,
    best_efficiency_stocks: bestEfficiencyRows,
    open_positions: openPositionRows,
    capital_series: capitalRows,
    monthly_summary: monthlyRows,
    index_coverage: indexCoverage,
    index_correlation: indexCorrelation,
    benchmark_curve: benchmarkCurve,
  };
}

/* =========================================================
   大盤連線測試 / 上傳大盤指數 CSV
   ========================================================= */

testConnectionBtn.addEventListener("click", async () => {
  testConnectionBtn.disabled = true;
  testConnectionBtn.textContent = "測試中…";
  try {
    const result = await IndexData.checkTaiexConnection();
    if (result.ok) {
      alert("連線正常：" + result.message);
    } else {
      alert(
        "連不到證交所，錯誤原因：\n\n" + result.message +
        "\n\n（測試日期：" + result.testedDate + "）\n\n" +
        "瀏覽器版常見的原因是證交所這支端點沒有開放跨來源請求（CORS），" +
        "這是瀏覽器的安全機制擋下的，不是網路本身的問題。" +
        "這種情況下請改用「上傳大盤指數 CSV」，一定能用。"
      );
    }
  } catch (err) {
    alert("測試連線時發生錯誤：" + (err && err.message ? err.message : err));
    console.error(err);
  } finally {
    testConnectionBtn.disabled = false;
    testConnectionBtn.textContent = "測試大盤連線";
  }
});

indexPickBtn.addEventListener("click", () => {
  indexFileInput.value = "";
  indexFileInput.click();
});

indexFileInput.addEventListener("change", async () => {
  const files = Array.from(indexFileInput.files || []);
  if (!files.length) return;

  indexPickBtn.disabled = true;
  indexPickBtn.textContent = "讀取中…";
  try {
    const texts = [];
    for (const file of files) texts.push(await Encoding.decodeFileText(file));
    const parsed = IndexData.parseIndexCsvTexts(texts);

    if (!Object.keys(parsed).length) {
      alert(
        "大盤指數 CSV 讀取失敗：\n\n這幾份檔案沒有解析出任何大盤指數資料，" +
        "請確認是證交所「發行量加權股價指數歷史資料」頁面下載的 CSV，" +
        "欄位需要包含「日期」跟「收盤指數」。"
      );
      return;
    }

    IndexData.mergeCsvIntoCache(indexCloseCache, parsed);
    IndexData.saveIndexCache(indexCloseCache);

    const dates = Object.keys(indexCloseCache).map(Number).sort((a, b) => a - b);
    indexFileTag.textContent =
      `大盤資料已載入 ${DateUtil.toISO(dates[0])} → ${DateUtil.toISO(dates[dates.length - 1])}（共 ${dates.length} 天）`;

    // 已經分析過的話，用同一批交易直接重新整理畫面，不用重新選對帳單
    if (_lastAnalysis) renderResult(buildAnalysisPayload());
  } catch (err) {
    alert("大盤指數 CSV 讀取失敗：" + (err && err.message ? err.message : err));
    console.error(err);
  } finally {
    indexPickBtn.disabled = false;
    indexPickBtn.textContent = "上傳大盤指數 CSV（選填）";
  }
});

/* =========================================================
   立即抓取大盤資料（手動連網）/ 清除大盤快取
   ========================================================= */

fetchMissingBtn.addEventListener("click", async () => {
  if (!_lastAnalysis) {
    alert(
      "請先按「選擇 CSV 並分析」跑一次分析，才知道哪些日期缺大盤資料；" +
      "如果分析完「大盤對應分析」區塊顯示涵蓋率已經 100%，就代表沒有缺漏需要補了。"
    );
    return;
  }
  if (!_lastMissingDates.length) {
    alert("目前沒有已知缺少的大盤資料，不需要連網補齊。");
    return;
  }

  fetchMissingBtn.disabled = true;
  fetchMissingBtn.textContent = "抓取中…";
  try {
    const requestedCount = _lastMissingDates.length;
    const { result: fetched, errorMessage } = await IndexData.fetchTaiexRange(
      _lastMissingDates,
      (done, total) => { fetchMissingBtn.textContent = `抓取中…（${done}/${total}）`; }
    );

    const fetchedForNeeded = _lastMissingDates.filter((d) => d in fetched).length;
    if (Object.keys(fetched).length) {
      IndexData.mergeFetchedIntoCache(indexCloseCache, fetched);
      IndexData.saveIndexCache(indexCloseCache);
    }

    let msg = `這次抓到 ${fetchedForNeeded} / ${requestedCount} 天需要的大盤資料。`;
    if (errorMessage) {
      msg += `\n\n連線中途出了狀況，沒有全部抓完：\n${errorMessage}` +
        `\n\n瀏覽器版如果一直抓不到，多半是證交所端點擋下跨來源請求（CORS）。改用「上傳大盤指數 CSV」一定能用。`;
    } else if (fetchedForNeeded < requestedCount) {
      msg += `\n\n還有 ${requestedCount - fetchedForNeeded} 天沒抓到（可能是假日，證交所本來就沒有資料）。`;
    }
    msg += "\n\n已經用同一份對帳單重新整理畫面。";
    alert(msg);

    renderResult(buildAnalysisPayload());

    const allDates = Object.keys(indexCloseCache).map(Number).sort((a, b) => a - b);
    if (allDates.length) {
      indexFileTag.textContent =
        `大盤資料已載入 ${DateUtil.toISO(allDates[0])} → ${DateUtil.toISO(allDates[allDates.length - 1])}（共 ${allDates.length} 天）`;
    }
  } catch (err) {
    alert("抓取大盤資料時發生錯誤：" + (err && err.message ? err.message : err));
    console.error(err);
  } finally {
    fetchMissingBtn.disabled = false;
    fetchMissingBtn.textContent = "立即抓取大盤資料";
  }
});

clearIndexCacheBtn.addEventListener("click", async () => {
  if (!confirm(
    "確定要清除已儲存的大盤指數資料嗎？\n\n清除之後，之前上傳或抓取過的大盤資料都會不見，" +
    "需要重新上傳或重新抓取。這個動作沒辦法復原。"
  )) return;

  const clearedDays = Object.keys(indexCloseCache).length;
  IndexData.clearIndexCache(indexCloseCache);
  indexFileTag.textContent = "";
  _lastMissingDates = [];

  // 有分析結果的話一併重新整理，讓「大盤對應分析」立刻顯示成沒有資料
  if (_lastAnalysis) renderResult(buildAnalysisPayload());

  alert(`已清除 ${clearedDays} 天的大盤資料。可以重新上傳 CSV，或分析完之後按「立即抓取大盤資料」重新取得。`);
});

/* =========================================================
   畫面渲染
   ========================================================= */

function renderResult(data) {
  const {
    summary, trades, filenames, duplicate_count, raw_transaction_count,
    symbol_summary, best_efficiency_stocks, open_positions, capital_series, monthly_summary,
    index_coverage, index_correlation, benchmark_curve,
  } = data;

  const fileLabel = filenames && filenames.length
    ? (filenames.length === 1
        ? `已載入：${filenames[0]}`
        : `已載入 ${filenames.length} 個檔案，合併 ${raw_transaction_count} 筆委託` +
          (duplicate_count > 0 ? `（自動排除 ${duplicate_count} 筆重複）` : ""))
    : "";
  document.getElementById("filenameTag").textContent = fileLabel;
  emptyState.style.display = "none";
  resultArea.style.display = "block";

  // 可疑配對警示
  const suspectCount = summary["排除可疑配對筆數"] || 0;
  const banner = document.getElementById("suspectBanner");
  if (suspectCount > 0) {
    banner.style.display = "block";
    banner.innerHTML =
      `<b>⚠ 有 ${suspectCount} 筆配對被排除在統計之外。</b>　` +
      `現股交易理論上不會跨日放空，這幾筆「空單」配對代表賣出當下持有的股票，` +
      `很可能是在這份對帳單涵蓋範圍開始之前就已經買進的庫存，配對到的進場價其實是後面一筆不相干的買進，` +
      `損益數字不可靠，所以沒有算進已實現損益跟勝率裡。下面表格用 <span class="suspect-tag">可疑</span> 標記出這幾筆，` +
      `想要更準確的結果，建議匯出涵蓋期間往前拉長，蓋過所有目前持股最早買進日的對帳單。`;
  } else {
    banner.style.display = "none";
  }

  // Hero
  const heroEl = document.getElementById("heroPnl");
  heroEl.textContent = fmt(summary["已實現損益"], { showSign: true });
  heroEl.className = "hero-number " + gainLossClass(summary["已實現損益"]);
  const rangeLabel = summary["資料起始日"] ? `　${summary["資料起始日"]} → ${summary["資料結束日"]}` : "";
  document.getElementById("heroMeta").textContent =
    `${summary["完整配對交易筆數"]} 筆完整配對交易　勝 ${summary["勝場"]}　敗 ${summary["敗場"]}　平 ${summary["平盤"]}${rangeLabel}`;

  // 核心績效
  const coreStats = [
    statCell("勝率", fmt(summary["勝率"], { decimals: 1 }) + "%"),
    statCell("平均持有天數", fmt(summary["平均持有天數"], { decimals: 1 }) + " 天"),
    statCell("獲利因子", summary["獲利因子"] !== null ? fmt(summary["獲利因子"], { decimals: 2 }) : "—"),
    statCell("單筆期望值", summary["單筆期望值"] !== null ? fmt(summary["單筆期望值"], { showSign: true }) : "—", gainLossClass(summary["單筆期望值"]), "平均每筆交易的損益"),
    statCell("平均獲利", fmt(summary["平均獲利"], { showSign: true }), "gain"),
    statCell("平均虧損", fmt(summary["平均虧損"], { showSign: true }), "loss"),
    statCell("最大單筆獲利", fmt(summary["最大單筆獲利"], { showSign: true }), "gain", summary["最大單筆獲利股名"] || ""),
    statCell("最大單筆虧損", fmt(summary["最大單筆虧損"], { showSign: true }), "loss", summary["最大單筆虧損股名"] || ""),
  ];
  document.getElementById("statGrid").innerHTML = coreStats.join("");

  // 資金效率
  const peakSub = summary["尖峰在場資金日期"] ? `發生於 ${summary["尖峰在場資金日期"]}` : "";
  const latestSub = summary["最新在場資金日期"] ? `資料最後一天 ${summary["最新在場資金日期"]}` : "";
  const capitalStats = [
    statCell("尖峰在場資金", fmt(summary["尖峰在場資金"]), "neutral", peakSub),
    statCell("最新在場資金", fmt(summary["最新在場資金"]), "neutral", latestSub),
    statCell("平均在場資金（時間加權）", fmt(summary["時間加權平均占用本金"])),
    statCell("中位數在場資金", fmt(summary["中位數在場資金"])),
    statCell("雙邊總成交額", fmt(summary["雙邊總成交額"])),
    statCell("總獲利率（平均資金）", summary["總獲利率_平均資金"] !== null ? fmt(summary["總獲利率_平均資金"], { decimals: 1, showSign: true }) + "%" : "—", gainLossClass(summary["總獲利率_平均資金"])),
    statCell("年化獲利率（平均資金）", summary["年化獲利率_平均資金"] !== null ? fmt(summary["年化獲利率_平均資金"], { decimals: 1, showSign: true }) + "%" : "—", gainLossClass(summary["年化獲利率_平均資金"]), "線性年化，非複利"),
    statCell("總獲利率（尖峰資金）", summary["總獲利率_尖峰資金"] !== null ? fmt(summary["總獲利率_尖峰資金"], { decimals: 1, showSign: true }) + "%" : "—", gainLossClass(summary["總獲利率_尖峰資金"])),
    statCell("年化獲利率（尖峰資金）", summary["年化獲利率_尖峰資金"] !== null ? fmt(summary["年化獲利率_尖峰資金"], { decimals: 1, showSign: true }) + "%" : "—", gainLossClass(summary["年化獲利率_尖峰資金"]), "線性年化，非複利"),
    statCell("資金週轉率", summary["資金週轉率"] !== null ? fmt(summary["資金週轉率"], { decimals: 2 }) + " 次" : "—", "neutral", "雙邊成交額 ÷ 平均在場資金"),
    statCell("凹單率", summary["凹單率"] !== null ? fmt(summary["凹單率"], { decimals: 1 }) + "%" : "—", "neutral", `持有超過平均 ${fmt(summary["平均持有天數"], { decimals: 1 })} 天還沒出場的資金佔比`),
    statCell("夏普值", summary["夏普值"] !== null ? fmt(summary["夏普值"], { decimals: 3 }) : "—", "neutral", "資金占用日報酬率，未年化"),
    statCell("索提諾比率", summary["索提諾比率"] !== null ? fmt(summary["索提諾比率"], { decimals: 3 }) : "—", "neutral", "只計入下檔波動，未年化"),
    statCell("交易成本佔成交額比", summary["交易成本佔成交額比"] !== null ? fmt(summary["交易成本佔成交額比"], { decimals: 3 }) + "%" : "—"),
    statCell("手續費＋交易稅合計", fmt(summary["手續費交易稅合計"])),
    statCell("資金占用報酬率（逐筆平均年化）", summary["資金占用報酬率_簡單年化"] !== null ? fmt(summary["資金占用報酬率_簡單年化"], { decimals: 1, showSign: true }) + "%" : "—", gainLossClass(summary["資金占用報酬率_簡單年化"]), "每筆交易單日報酬率取平均後年化"),
  ];
  document.getElementById("capitalStatGrid").innerHTML = capitalStats.join("");

  // 效益比 Top 3
  const bestEfficiencyBody = document.getElementById("bestEfficiencyBody");
  const efficiencyRows = best_efficiency_stocks || [];
  if (efficiencyRows.length) {
    bestEfficiencyBody.innerHTML = efficiencyRows.map((s, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${s["股票代號"]}</td>
        <td>${s["股票名稱"]}</td>
        <td>${fmt(s["效益比"], { decimals: 1 })}</td>
        <td class="pnl-gain">${fmt(s["平均報酬率"], { decimals: 2, showSign: true })}%</td>
        <td>${fmt(s["平均持有天數"], { decimals: 1 })}</td>
        <td class="pnl-gain">${fmt(s["總損益"], { showSign: true })}</td>
      </tr>
    `).join("");
  } else {
    bestEfficiencyBody.innerHTML =
      `<tr><td colspan="7" style="color:var(--text-dim); text-align:center; padding:20px;">沒有符合資格的股票（例如全部都賠錢）</td></tr>`;
  }

  // 各檔損益彙總
  const symbolBody = document.getElementById("symbolBody");
  symbolBody.innerHTML = (symbol_summary || []).map((s) => `
    <tr>
      <td>${s["股票代號"]}</td>
      <td>${s["股票名稱"]}</td>
      <td>${s["交易次數"]}</td>
      <td>${s["勝場"]}</td>
      <td>${fmt(s["勝率"], { decimals: 0 })}%</td>
      <td class="${s["總損益"] >= 0 ? "pnl-gain" : "pnl-loss"}">${fmt(s["總損益"], { showSign: true })}</td>
      <td class="${s["平均報酬率"] >= 0 ? "pnl-gain" : "pnl-loss"}">${fmt(s["平均報酬率"], { decimals: 2, showSign: true })}%</td>
      <td>${fmt(s["平均持有天數"], { decimals: 1 })}</td>
    </tr>
  `).join("");

  // 期末未平倉
  const openBody = document.getElementById("openPositionsBody");
  const openRows = open_positions || [];
  let openHtml = openRows.map((p) => {
    const pct = p["佔未平倉比例"] ?? 0;
    return `
    <tr>
      <td>${p["股票代號"]}</td>
      <td>${p["股票名稱"]}</td>
      <td>${fmt(p["持有股數"])}</td>
      <td>${fmt(p["持有成本"])}</td>
      <td>${fmt(p["成本均價"], { decimals: 2 })}</td>
      <td>
        <div class="pct-cell">
          <span class="pct-value">${fmt(pct, { decimals: 1 })}%</span>
          <span class="pct-bar"><span class="pct-bar-fill" style="width:${Math.min(pct, 100)}%"></span></span>
        </div>
      </td>
    </tr>
  `;
  }).join("");
  if (openRows.length) {
    const totalCost = openRows.reduce((sum, p) => sum + p["持有成本"], 0);
    openHtml += `
      <tr class="total-row">
        <td colspan="3">合計</td>
        <td>${fmt(totalCost)}</td>
        <td></td>
        <td style="text-align:right;">100.0%</td>
      </tr>
    `;
  } else {
    openHtml = `<tr><td colspan="6" style="color:var(--text-dim); text-align:center; padding:20px;">沒有推算出未平倉部位</td></tr>`;
  }
  openBody.innerHTML = openHtml;

  // 大盤對應分析
  const corr = index_correlation || {};
  const coverage = index_coverage || {};
  const indexEmpty = document.getElementById("indexCorrelationEmpty");
  const indexGrid = document.getElementById("indexCorrelationGrid");
  const indexCoverageNote = document.getElementById("indexCoverageNote");

  if ((coverage["已涵蓋天數"] || 0) > 0) {
    indexEmpty.style.display = "none";
    const corrStats = [
      statCell(
        "進場日大盤平均漲跌%",
        corr["進場日大盤平均漲跌%"] !== null && corr["進場日大盤平均漲跌%"] !== undefined
          ? fmt(corr["進場日大盤平均漲跌%"], { decimals: 2, showSign: true }) + "%" : "—",
        gainLossClass(corr["進場日大盤平均漲跌%"])
      ),
      statCell(
        "出場日大盤平均漲跌%",
        corr["出場日大盤平均漲跌%"] !== null && corr["出場日大盤平均漲跌%"] !== undefined
          ? fmt(corr["出場日大盤平均漲跌%"], { decimals: 2, showSign: true }) + "%" : "—",
        gainLossClass(corr["出場日大盤平均漲跌%"])
      ),
      statCell(
        "進場日為大盤下跌的比例",
        corr["進場日為大盤下跌的比例"] !== null && corr["進場日為大盤下跌的比例"] !== undefined
          ? fmt(corr["進場日為大盤下跌的比例"], { decimals: 1 }) + "%" : "—",
        "neutral",
        `${corr["有大盤資料的進場筆數"] || 0} 筆有大盤資料`
      ),
      statCell(
        "出場日為大盤上漲的比例",
        corr["出場日為大盤上漲的比例"] !== null && corr["出場日為大盤上漲的比例"] !== undefined
          ? fmt(corr["出場日為大盤上漲的比例"], { decimals: 1 }) + "%" : "—",
        "neutral",
        `${corr["有大盤資料的出場筆數"] || 0} 筆有大盤資料`
      ),
      statCell(
        "賣飛比例",
        corr["賣飛比例"] !== null && corr["賣飛比例"] !== undefined
          ? fmt(corr["賣飛比例"], { decimals: 1 }) + "%" : "—",
        "neutral",
        `出場後 ${corr["賣飛門檻天數"] ?? 2} 個交易日內大盤漲超過 ${corr["賣飛門檻漲幅"] ?? 4}%，${corr["有賣飛資料的出場筆數"] || 0} 筆有資料`
      ),
      statCell(
        "進場日平均乖離%",
        corr["進場日平均乖離%"] !== null && corr["進場日平均乖離%"] !== undefined
          ? fmt(corr["進場日平均乖離%"], { decimals: 2, showSign: true }) + "%" : "—",
        gainLossClass(corr["進場日平均乖離%"]),
        `相對 ${corr["乖離均線天數"] ?? 6} 日均線，${corr["有乖離資料的進場筆數"] || 0} 筆有資料`
      ),
      statCell(
        "出場日平均乖離%",
        corr["出場日平均乖離%"] !== null && corr["出場日平均乖離%"] !== undefined
          ? fmt(corr["出場日平均乖離%"], { decimals: 2, showSign: true }) + "%" : "—",
        gainLossClass(corr["出場日平均乖離%"]),
        `相對 ${corr["乖離均線天數"] ?? 6} 日均線，${corr["有乖離資料的出場筆數"] || 0} 筆有資料`
      ),
    ];
    indexGrid.innerHTML = corrStats.join("");

    let note = `${coverage["已涵蓋天數"]} / ${coverage["需要天數"]} 個交易日有大盤資料`;
    if (coverage["缺漏天數"] > 0) note += `，還缺 ${coverage["缺漏天數"]} 天（可以按上方「立即抓取大盤資料」連網補齊，或上傳大盤指數 CSV）`;
    indexCoverageNote.textContent = note;
  } else {
    indexEmpty.style.display = "block";
    indexGrid.innerHTML = "";
    indexCoverageNote.textContent = "";
  }

  // 交易明細
  const tbody = document.getElementById("tradesBody");
  tbody.innerHTML = trades.map((t) => {
    const entryPct = t["進場日大盤漲跌%"];
    const exitPct = t["出場日大盤漲跌%"];
    const entryPctCls = entryPct === null || entryPct === undefined ? "" : (entryPct >= 0 ? "pnl-gain" : "pnl-loss");
    const exitPctCls = exitPct === null || exitPct === undefined ? "" : (exitPct >= 0 ? "pnl-gain" : "pnl-loss");
    const entryPctText = entryPct === null || entryPct === undefined ? "—" : fmt(entryPct, { decimals: 2, showSign: true }) + "%";
    const exitPctText = exitPct === null || exitPct === undefined ? "—" : fmt(exitPct, { decimals: 2, showSign: true }) + "%";
    const sellTag = t["賣飛"] === true
      ? `<span class="sell-tag" title="出場後 ${corr["賣飛門檻天數"] ?? 2} 個交易日內，大盤漲超過 ${corr["賣飛門檻漲幅"] ?? 4}%">賣飛</span>`
      : "";
    const entryBias = t["進場日乖離%"];
    const exitBias = t["出場日乖離%"];
    const entryBiasCls = entryBias === null || entryBias === undefined ? "" : (entryBias >= 0 ? "pnl-gain" : "pnl-loss");
    const exitBiasCls = exitBias === null || exitBias === undefined ? "" : (exitBias >= 0 ? "pnl-gain" : "pnl-loss");
    const entryBiasText = entryBias === null || entryBias === undefined ? "—" : fmt(entryBias, { decimals: 2, showSign: true }) + "%";
    const exitBiasText = exitBias === null || exitBias === undefined ? "—" : fmt(exitBias, { decimals: 2, showSign: true }) + "%";
    return `
    <tr>
      <td>${t["股票代號"]}</td>
      <td>${t["股票名稱"]}${t["可疑配對"] ? '<span class="suspect-tag">可疑</span>' : ""}</td>
      <td><span class="dir-tag">${t["方向"]}</span></td>
      <td>${t["進場日"]}</td>
      <td class="${entryPctCls}">${entryPctText}</td>
      <td class="${entryBiasCls}" title="進場日相對 ${corr["乖離均線天數"] ?? 6} 日均線的乖離率">${entryBiasText}</td>
      <td>${t["出場日"]}</td>
      <td class="${exitPctCls}">${exitPctText}${sellTag}</td>
      <td class="${exitBiasCls}" title="出場日相對 ${corr["乖離均線天數"] ?? 6} 日均線的乖離率">${exitBiasText}</td>
      <td>${t["持有天數"]}</td>
      <td>${fmt(t["配對股數"])}</td>
      <td>${fmt(t["進場價"], { decimals: 2 })}</td>
      <td>${fmt(t["出場價"], { decimals: 2 })}</td>
      <td class="${t["報酬率"] >= 0 ? "pnl-gain" : "pnl-loss"}">${fmt(t["報酬率"], { decimals: 2, showSign: true })}%</td>
      <td class="${t["淨損益"] >= 0 ? "pnl-gain" : "pnl-loss"}">${fmt(t["淨損益"], { showSign: true })}</td>
    </tr>
  `;
  }).join("");

  const cleanTrades = trades.filter((t) => !t["可疑配對"]);
  const range = cleanTrades.length ? `${cleanTrades[0]["出場日"]} → ${cleanTrades[cleanTrades.length - 1]["出場日"]}` : "";
  document.getElementById("curveRange").textContent = range;

  const cap = capital_series || [];
  document.getElementById("capitalRange").textContent =
    cap.length ? `${cap[0]["日期"]} → ${cap[cap.length - 1]["日期"]}` : "";

  const capitalLegend = document.getElementById("capitalLegend");
  const hasOverheldData = cap.some((p) => (p["凹單資金"] || 0) > 0);
  if (hasOverheldData) {
    capitalLegend.style.display = "flex";
    const overheldPct = summary["凹單率"];
    capitalLegend.innerHTML = `
      <span><span class="swatch" style="background:#d4a24e;"></span>在場資金</span>
      <span><span class="swatch" style="background:#c9665a;"></span>凹單（持有超過平均 ${fmt(summary["平均持有天數"], { decimals: 1 })} 天還沒出場）</span>
      <span>凹單率 ${overheldPct !== null && overheldPct !== undefined ? fmt(overheldPct, { decimals: 1 }) + "%" : "—"}</span>
    `;
  } else {
    capitalLegend.style.display = "none";
    capitalLegend.innerHTML = "";
  }

  const monthly = monthly_summary || [];
  const monthlyRange = monthly.length ? `${monthly[0]["月份"]} → ${monthly[monthly.length - 1]["月份"]}` : "";
  document.getElementById("freqRange").textContent = monthlyRange;
  document.getElementById("monthlyPnlRange").textContent = monthlyRange;

  const benchmarkCurve = Array.isArray(benchmark_curve) && benchmark_curve.length === cleanTrades.length
    ? benchmark_curve : [];

  const equityLegend = document.getElementById("equityLegend");
  const benchmarkValuesForLegend = benchmarkCurve.map((c) => c && c["大盤基準損益"]).filter((v) => v !== null && v !== undefined);
  if (benchmarkValuesForLegend.length) {
    const finalStrategy = cleanTrades.reduce((sum, t) => sum + t["淨損益"], 0);
    const finalBenchmark = benchmarkValuesForLegend[benchmarkValuesForLegend.length - 1];
    const alpha = finalStrategy - finalBenchmark;
    const alphaColor = alpha > 0 ? "#ff4d5e" : (alpha < 0 ? "#2ed573" : "var(--text-primary)");
    equityLegend.style.display = "flex";
    equityLegend.innerHTML = `
      <span><span class="swatch" style="background:#d4a24e;"></span>您的策略 ${fmt(finalStrategy, { showSign: true })}</span>
      <span><span class="swatch dashed" style="border-color:#7a93b5;"></span>大盤基準（同資金被動持有）${fmt(finalBenchmark, { showSign: true })}</span>
      <span style="color:${alphaColor};">超額 ${fmt(alpha, { showSign: true })}</span>
    `;
  } else {
    equityLegend.style.display = "none";
    equityLegend.innerHTML = "";
  }

  window.__lastTrades = cleanTrades;
  window.__lastBenchmarkCurve = benchmarkCurve;
  window.__lastCapitalSeries = cap;
  window.__lastMonthlySummary = monthly;

  const eqCanvas = document.getElementById("equityCanvas");
  const capCanvas = document.getElementById("capitalCanvas");
  const freqCanvas = document.getElementById("freqCanvas");
  const pnlCanvas = document.getElementById("monthlyPnlCanvas");

  drawEquityCurve(eqCanvas, cleanTrades, benchmarkCurve);
  drawCapitalCurve(capCanvas, cap);
  drawFrequencyBarChart(freqCanvas, monthly);
  drawMonthlyPnlBarChart(pnlCanvas, monthly);

  attachLineHover(eqCanvas, () => drawEquityCurve(eqCanvas, window.__lastTrades, window.__lastBenchmarkCurve));
  attachLineHover(capCanvas, () => drawCapitalCurve(capCanvas, window.__lastCapitalSeries));
  attachBarHover(freqCanvas, () => drawFrequencyBarChart(freqCanvas, window.__lastMonthlySummary));
  attachBarHover(pnlCanvas, () => drawMonthlyPnlBarChart(pnlCanvas, window.__lastMonthlySummary));
}

function setupCanvas(canvas, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || canvas.parentElement.clientWidth;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  canvas.style.height = cssHeight + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  return { ctx, cssWidth, cssHeight };
}

/* =========================================================
   滑鼠十字準線（權益曲線 / 資金水位共用）
   draw 函式畫完線之後，把每個資料點的畫面座標跟提示文字
   存在 canvas.__hoverPoints，hover 的時候只要找最近的點，
   重畫一次乾淨的底圖，再疊一層十字準線跟提示框
   ========================================================= */

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawTooltipBox(ctx, anchorX, top, bottom, cssWidth, lines, centered) {
  ctx.font = "11px Consolas, monospace";
  let textW = 0;
  lines.forEach((l) => { textW = Math.max(textW, ctx.measureText(l.text).width); });
  const boxW = textW + 18;
  const boxH = 10 + lines.length * 16;

  let boxX = centered ? anchorX - boxW / 2 : anchorX + 12;
  if (!centered && boxX + boxW > cssWidth - 4) boxX = anchorX - boxW - 12;
  boxX = Math.max(4, Math.min(boxX, cssWidth - boxW - 4));
  const boxY = centered ? top + 4 : top;

  ctx.fillStyle = "rgba(20,24,34,0.96)";
  ctx.strokeStyle = "#262b38";
  ctx.lineWidth = 1;
  roundRect(ctx, boxX, boxY, boxW, boxH, 4);
  ctx.fill();
  ctx.stroke();

  lines.forEach((l, i) => {
    ctx.fillStyle = l.color || "#e8eaed";
    ctx.font = (l.bold ? "600 12px " : "11px ") + "Consolas, monospace";
    ctx.textAlign = "left";
    ctx.fillText(l.text, boxX + 9, boxY + 16 + i * 16);
  });
}

function drawLineHoverOverlay(canvas, point) {
  const meta = canvas.__hoverMeta;
  if (!meta) return;
  const ctx = canvas.getContext("2d");
  ctx.save();

  ctx.strokeStyle = "rgba(232,234,237,0.35)";
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(point.x, meta.top);
  ctx.lineTo(point.x, meta.bottom);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = point.color || "#d4a24e";
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#0b0e14";
  ctx.stroke();

  drawTooltipBox(ctx, point.x, meta.top, meta.bottom, meta.cssWidth, point.lines, false);
  ctx.restore();
}

function attachLineHover(canvas, redraw) {
  if (canvas.dataset.hoverBound) return;
  canvas.dataset.hoverBound = "1";

  canvas.addEventListener("mousemove", (e) => {
    const points = canvas.__hoverPoints;
    if (!points || points.length < 1) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    let nearest = points[0];
    let minDist = Infinity;
    for (const p of points) {
      const d = Math.abs(p.x - mouseX);
      if (d < minDist) { minDist = d; nearest = p; }
    }
    redraw();
    drawLineHoverOverlay(canvas, nearest);
  });

  canvas.addEventListener("mouseleave", () => {
    redraw();
  });
}

/* =========================================================
   柱狀圖滑鼠互動（交易頻率 / 每月損益共用）
   ========================================================= */

function drawBarHoverOverlay(canvas, bar) {
  const meta = canvas.__hoverMeta;
  if (!meta) return;
  const ctx = canvas.getContext("2d");
  ctx.save();

  ctx.fillStyle = "rgba(232,234,237,0.07)";
  ctx.fillRect(bar.x - 2, meta.top, bar.width + 4, meta.bottom - meta.top);

  drawTooltipBox(ctx, bar.x + bar.width / 2, meta.top, meta.bottom, meta.cssWidth, bar.lines, true);
  ctx.restore();
}

function attachBarHover(canvas, redraw) {
  if (canvas.dataset.hoverBound) return;
  canvas.dataset.hoverBound = "1";

  canvas.addEventListener("mousemove", (e) => {
    const bars = canvas.__hoverBars;
    if (!bars || !bars.length) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const bar = bars.find((b) => mouseX >= b.x - 1 && mouseX <= b.x + b.width + 1);
    redraw();
    if (bar) drawBarHoverOverlay(canvas, bar);
  });

  canvas.addEventListener("mouseleave", () => {
    redraw();
  });
}

/* =========================================================
   權益曲線 / 資金水位
   ========================================================= */

function drawEquityCurve(canvas, trades, benchmarkCurve) {
  canvas.__hoverPoints = [];
  const { ctx, cssWidth, cssHeight } = setupCanvas(canvas, 220);
  if (!trades.length) return;

  const hasBenchmark = Array.isArray(benchmarkCurve) && benchmarkCurve.length === trades.length;

  // 計算累積損益序列，第 0 點為 0
  const cumulative = [0];
  let running = 0;
  for (const t of trades) {
    running += t["淨損益"];
    cumulative.push(running);
  }

  // 大盤基準序列，跟累積損益用同一個 x 軸對齊；沒有資料的點是 null，畫線的時候會斷開
  const benchmarkValues = hasBenchmark
    ? [0, ...benchmarkCurve.map((c) => (c && c["大盤基準損益"] !== null && c["大盤基準損益"] !== undefined) ? c["大盤基準損益"] : null)]
    : null;

  const padding = { top: 16, right: 8, bottom: 8, left: 8 };
  const plotW = cssWidth - padding.left - padding.right;
  const plotH = cssHeight - padding.top - padding.bottom;

  const benchmarkNonNull = benchmarkValues ? benchmarkValues.filter((v) => v !== null) : [];
  const maxV = Math.max(...cumulative, ...benchmarkNonNull, 0);
  const minV = Math.min(...cumulative, ...benchmarkNonNull, 0);
  const span = (maxV - minV) || 1;

  const xAt = (i) => padding.left + (i / (cumulative.length - 1)) * plotW;
  const yAt = (v) => padding.top + (1 - (v - minV) / span) * plotH;
  const zeroY = yAt(0);

  // 零基準線
  ctx.strokeStyle = "rgba(138,146,163,0.35)";
  ctx.setLineDash([3, 4]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding.left, zeroY);
  ctx.lineTo(cssWidth - padding.right, zeroY);
  ctx.stroke();
  ctx.setLineDash([]);

  // 面積填色：以零線為界，上方紅（獲利區）下方綠（虧損區）
  const gainColor = "rgba(255,77,94,0.16)";
  const lossColor = "rgba(46,213,115,0.16)";

  function fillRegion(predicate, color) {
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < cumulative.length; i++) {
      const x = xAt(i);
      const y = yAt(cumulative[i]);
      const clampedY = predicate(cumulative[i]) ? y : zeroY;
      if (!started) { ctx.moveTo(x, clampedY); started = true; }
      else ctx.lineTo(x, clampedY);
    }
    ctx.lineTo(xAt(cumulative.length - 1), zeroY);
    ctx.lineTo(xAt(0), zeroY);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  fillRegion((v) => v >= 0, gainColor);
  fillRegion((v) => v < 0, lossColor);

  // 大盤基準線：把平均在場資金整個壓進大盤、抱著不動的假設性損益，虛線、
  // 淺藍灰色跟主線的琥珀色區隔開，遇到沒有資料的點就斷開，不會連過去硬畫
  const benchmarkColor = "#7a93b5";
  if (benchmarkValues) {
    ctx.strokeStyle = benchmarkColor;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    let segmentStarted = false;
    benchmarkValues.forEach((v, i) => {
      if (v === null) { segmentStarted = false; return; }
      const x = xAt(i);
      const y = yAt(v);
      if (!segmentStarted) { ctx.moveTo(x, y); segmentStarted = true; }
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 主線（你的策略）
  ctx.beginPath();
  cumulative.forEach((v, i) => {
    const x = xAt(i);
    const y = yAt(v);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "#d4a24e";
  ctx.lineWidth = 1.8;
  ctx.stroke();

  // 端點數值（你的策略）
  ctx.fillStyle = running >= 0 ? "#ff4d5e" : "#2ed573";
  ctx.font = "11px Consolas, monospace";
  ctx.textAlign = "right";
  ctx.fillText(fmt(running, { showSign: true }), cssWidth - padding.right, yAt(running) - 8);

  // 端點數值（大盤基準，找最後一個有資料的點標註）
  if (benchmarkValues) {
    let lastIdx = -1;
    for (let i = benchmarkValues.length - 1; i >= 0; i--) {
      if (benchmarkValues[i] !== null) { lastIdx = i; break; }
    }
    if (lastIdx >= 0) {
      const v = benchmarkValues[lastIdx];
      const atRightEdge = lastIdx === cumulative.length - 1;
      let labelY = yAt(v) - 8;
      if (atRightEdge && Math.abs(labelY - (yAt(running) - 8)) < 14) {
        labelY = yAt(v) + 14;
      }
      ctx.fillStyle = benchmarkColor;
      ctx.font = "11px Consolas, monospace";
      ctx.textAlign = atRightEdge ? "right" : "left";
      const labelX = atRightEdge ? cssWidth - padding.right : xAt(lastIdx) + 4;
      ctx.fillText("大盤基準 " + fmt(v, { showSign: true }), labelX, labelY);
    }
  }

  // 給滑鼠十字準線用的資料點
  canvas.__hoverPoints = cumulative.map((v, i) => {
    const lines = [
      { text: i === 0 ? "起始" : trades[i - 1]["出場日"], color: "#8a92a3" },
      {
        text: (benchmarkValues ? "您的策略 " : "累積損益 ") + fmt(v, { showSign: true }),
        color: v >= 0 ? "#ff4d5e" : "#2ed573",
        bold: true,
      },
    ];
    if (benchmarkValues) {
      const bv = benchmarkValues[i];
      lines.push({
        text: bv !== null ? "大盤基準 " + fmt(bv, { showSign: true }) : "大盤基準 —",
        color: benchmarkColor,
      });
    }
    return { x: xAt(i), y: yAt(v), color: v >= 0 ? "#ff4d5e" : "#2ed573", lines };
  });
  canvas.__hoverMeta = { top: padding.top, bottom: cssHeight - padding.bottom, cssWidth };
}

function drawCapitalCurve(canvas, series) {
  canvas.__hoverPoints = [];
  const { ctx, cssWidth, cssHeight } = setupCanvas(canvas, 220);
  if (!series.length) return;

  const values = series.map((p) => p["在場資金"]);
  const overheldValues = series.map((p) => p["凹單資金"] || 0);
  const hasOverheld = overheldValues.some((v) => v > 0);

  const padding = { top: 16, right: 8, bottom: 8, left: 8 };
  const plotW = cssWidth - padding.left - padding.right;
  const plotH = cssHeight - padding.top - padding.bottom;

  const maxV = Math.max(...values, 1);
  const minV = 0;
  const span = (maxV - minV) || 1;

  const xAt = (i) => padding.left + (i / (values.length - 1)) * plotW;
  const yAt = (v) => padding.top + (1 - (v - minV) / span) * plotH;
  const baseY = yAt(0);

  // 平均線（虛線參考）
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  ctx.strokeStyle = "rgba(138,146,163,0.35)";
  ctx.setLineDash([3, 4]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding.left, yAt(avg));
  ctx.lineTo(cssWidth - padding.right, yAt(avg));
  ctx.stroke();
  ctx.setLineDash([]);

  // 面積填色（琥珀色，跟損益曲線的紅綠語意區隔開），代表總在場資金
  ctx.beginPath();
  ctx.moveTo(xAt(0), baseY);
  values.forEach((v, i) => ctx.lineTo(xAt(i), yAt(v)));
  ctx.lineTo(xAt(values.length - 1), baseY);
  ctx.closePath();
  ctx.fillStyle = "rgba(212,162,78,0.16)";
  ctx.fill();

  // 凹單資金疊在底層，用偏紅褐色的警示色區隔出來，是總在場資金裡的一塊子集
  if (hasOverheld) {
    ctx.beginPath();
    ctx.moveTo(xAt(0), baseY);
    overheldValues.forEach((v, i) => ctx.lineTo(xAt(i), yAt(v)));
    ctx.lineTo(xAt(overheldValues.length - 1), baseY);
    ctx.closePath();
    ctx.fillStyle = "rgba(201,102,90,0.45)";
    ctx.fill();

    ctx.beginPath();
    overheldValues.forEach((v, i) => {
      const x = xAt(i);
      const y = yAt(v);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "#c9665a";
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  // 主線（總在場資金）
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = xAt(i);
    const y = yAt(v);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "#d4a24e";
  ctx.lineWidth = 1.8;
  ctx.stroke();

  // 尖峰標註跟最新標註（兩者剛好同一天的話合併成一個標籤）
  const peakIdx = values.indexOf(maxV);
  const latestIdx = values.length - 1;
  const latestV = values[latestIdx];
  const peakY = yAt(maxV);

  ctx.font = "11px Consolas, monospace";
  ctx.fillStyle = "#d4a24e";
  ctx.textAlign = peakIdx > values.length * 0.7 ? "right" : "left";
  const peakLabel = peakIdx === latestIdx ? "尖峰／最新　" : "尖峰　";
  ctx.fillText(peakLabel + fmt(maxV), xAt(peakIdx), peakY - 8);

  if (peakIdx !== latestIdx) {
    let latestY = yAt(latestV) - 8;
    if (Math.abs(latestY - (peakY - 8)) < 14) latestY -= 14;
    ctx.fillStyle = "#e8eaed";
    ctx.textAlign = "right";
    ctx.fillText("最新　" + fmt(latestV), cssWidth - padding.right, latestY);
  }

  // 給滑鼠十字準線用的資料點
  canvas.__hoverPoints = series.map((p, i) => {
    const lines = [
      { text: p["日期"], color: "#8a92a3" },
      { text: "在場資金 " + fmt(p["在場資金"]), color: "#d4a24e", bold: true },
    ];
    if (hasOverheld) {
      lines.push({ text: "凹單 " + fmt(p["凹單資金"] || 0), color: "#c9665a" });
    }
    return { x: xAt(i), y: yAt(p["在場資金"]), color: "#d4a24e", lines };
  });
  canvas.__hoverMeta = { top: padding.top, bottom: cssHeight - padding.bottom, cssWidth };
}

/* =========================================================
   交易頻率 / 每月損益（柱狀圖）
   ========================================================= */

function barLayout(cssWidth, n, padding) {
  const plotW = cssWidth - padding.left - padding.right;
  const gap = n > 1 ? Math.min(10, (plotW / n) * 0.3) : 0;
  const barW = Math.max((plotW - gap * Math.max(n - 1, 0)) / Math.max(n, 1), 3);
  return { plotW, gap, barW };
}

function drawFrequencyBarChart(canvas, monthly) {
  canvas.__hoverBars = [];
  const { ctx, cssWidth, cssHeight } = setupCanvas(canvas, 220);
  if (!monthly.length) return;

  const padding = { top: 22, right: 8, bottom: 26, left: 8 };
  const plotH = cssHeight - padding.top - padding.bottom;
  const { gap, barW } = barLayout(cssWidth, monthly.length, padding);
  const maxV = Math.max(...monthly.map((m) => m["交易次數"]), 1);
  const labelStep = Math.max(Math.ceil(monthly.length / 10), 1);

  const bars = [];
  monthly.forEach((m, i) => {
    const x = padding.left + i * (barW + gap);
    const v = m["交易次數"];
    const h = (v / maxV) * plotH;
    const y = padding.top + (plotH - h);

    ctx.fillStyle = "#d4a24e";
    ctx.fillRect(x, y, barW, Math.max(h, 1));

    if (barW > 16) {
      ctx.fillStyle = "#8a92a3";
      ctx.font = "10px Consolas, monospace";
      ctx.textAlign = "center";
      ctx.fillText(String(v), x + barW / 2, y - 5);
    }

    if (i % labelStep === 0 || i === monthly.length - 1) {
      ctx.fillStyle = "#5b6275";
      ctx.font = "9.5px Consolas, monospace";
      ctx.textAlign = "center";
      ctx.fillText(m["月份"], x + barW / 2, cssHeight - 9);
    }

    bars.push({
      x, width: barW,
      lines: [
        { text: m["月份"], color: "#8a92a3" },
        { text: "交易次數 " + v + " 筆", color: "#d4a24e", bold: true },
      ],
    });
  });

  canvas.__hoverBars = bars;
  canvas.__hoverMeta = { top: padding.top, bottom: cssHeight - padding.bottom, cssWidth };
}

function drawMonthlyPnlBarChart(canvas, monthly) {
  canvas.__hoverBars = [];
  const { ctx, cssWidth, cssHeight } = setupCanvas(canvas, 220);
  if (!monthly.length) return;

  const padding = { top: 22, right: 8, bottom: 34, left: 8 };
  const plotH = cssHeight - padding.top - padding.bottom;
  const { gap, barW } = barLayout(cssWidth, monthly.length, padding);
  const values = monthly.map((m) => m["淨損益"]);
  const maxV = Math.max(...values, 0);
  const minV = Math.min(...values, 0);
  const span = (maxV - minV) || 1;
  const yAt = (v) => padding.top + (1 - (v - minV) / span) * plotH;
  const zeroY = yAt(0);
  const labelStep = Math.max(Math.ceil(monthly.length / 10), 1);

  const bars = [];
  monthly.forEach((m, i) => {
    const x = padding.left + i * (barW + gap);
    const v = m["淨損益"];
    const y = yAt(v);
    const top = Math.min(y, zeroY);
    const h = Math.max(Math.abs(zeroY - y), 1);
    const color = v >= 0 ? "#ff4d5e" : "#2ed573";

    ctx.fillStyle = color;
    ctx.fillRect(x, top, barW, h);

    if (barW > 16) {
      ctx.fillStyle = color;
      ctx.font = "10px Consolas, monospace";
      ctx.textAlign = "center";
      const labelY = v >= 0 ? top - 5 : top + h + 12;
      ctx.fillText(fmt(v, { showSign: true }), x + barW / 2, labelY);
    }

    if (i % labelStep === 0 || i === monthly.length - 1) {
      ctx.fillStyle = "#5b6275";
      ctx.font = "9.5px Consolas, monospace";
      ctx.textAlign = "center";
      ctx.fillText(m["月份"], x + barW / 2, cssHeight - 9);
    }

    bars.push({
      x, width: barW,
      lines: [
        { text: m["月份"], color: "#8a92a3" },
        { text: "淨損益 " + fmt(v, { showSign: true }), color, bold: true },
        { text: "交易 " + m["交易次數"] + " 筆／勝率 " + fmt(m["勝率"], { decimals: 0 }) + "%", color: "#8a92a3" },
      ],
    });
  });

  // 零基準線
  ctx.strokeStyle = "rgba(138,146,163,0.35)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding.left, zeroY);
  ctx.lineTo(cssWidth - padding.right, zeroY);
  ctx.stroke();

  canvas.__hoverBars = bars;
  canvas.__hoverMeta = { top: padding.top, bottom: cssHeight - padding.bottom, cssWidth };
}

window.addEventListener("resize", () => {
  if (resultArea.style.display === "none") return;
  const eqCanvas = document.getElementById("equityCanvas");
  if (eqCanvas && window.__lastTrades) {
    drawEquityCurve(eqCanvas, window.__lastTrades, window.__lastBenchmarkCurve);
  }
  const capCanvas = document.getElementById("capitalCanvas");
  if (capCanvas && window.__lastCapitalSeries) {
    drawCapitalCurve(capCanvas, window.__lastCapitalSeries);
  }
  const freqCanvas = document.getElementById("freqCanvas");
  if (freqCanvas && window.__lastMonthlySummary) {
    drawFrequencyBarChart(freqCanvas, window.__lastMonthlySummary);
  }
  const pnlCanvas = document.getElementById("monthlyPnlCanvas");
  if (pnlCanvas && window.__lastMonthlySummary) {
    drawMonthlyPnlBarChart(pnlCanvas, window.__lastMonthlySummary);
  }
});
