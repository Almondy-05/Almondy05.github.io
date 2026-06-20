/* =========================================================
   統計彙總層：把配對完成的交易，整理成使用者要看的數字
   對應 core/stats.py

   輸出物件一律沿用跟 Python 版本完全相同的中文鍵名，前端渲染邏輯才能
   原封不動沿用，不用整批改寫畫面層的程式碼。
   ========================================================= */
(function (global) {
  "use strict";

  // Python 風格的 round()（banker's rounding），實作在 numberUtil.js，
  // indexData.js 也會共用同一份，避免兩邊各自實作出現不一致
  const pyRound = NumberUtil.pyRound;

  // 「賣飛」指標的參數：出場之後，往後看幾個「有資料」的交易日，
  // 漲幅超過多少門檻就算賣飛
  const SELL_TOO_EARLY_TRADING_DAYS = 2;
  const SELL_TOO_EARLY_LOOKAHEAD_CALENDAR_DAYS = 14;
  const SELL_TOO_EARLY_THRESHOLD_PCT = 4.0;

  function sellTooEarlyLookaheadDates(exitDate) {
    const dates = [];
    for (let i = 1; i <= SELL_TOO_EARLY_LOOKAHEAD_CALENDAR_DAYS; i++) dates.push(exitDate + i);
    return dates;
  }

  // 「賣飛」指標：出場之後，大盤有沒有在接下來幾個交易日內漲超過門檻。
  // 出場日當天沒有大盤資料、或往後完全找不到任何有資料的交易日，回傳 null
  // （不知道，不是「沒有賣飛」）。
  function computeSellTooEarly(exitDate, indexChangeMap) {
    const exitInfo = indexChangeMap[exitDate];
    if (!exitInfo) return null;
    const exitClose = exitInfo["收盤指數"];

    const futureCloses = [];
    for (const d of sellTooEarlyLookaheadDates(exitDate)) {
      const info = indexChangeMap[d];
      if (info) futureCloses.push(info["收盤指數"]);
      if (futureCloses.length >= SELL_TOO_EARLY_TRADING_DAYS) break;
    }
    if (!futureCloses.length) return null;

    const gainPct = ((Math.max(...futureCloses) - exitClose) / exitClose) * 100;
    return gainPct > SELL_TOO_EARLY_THRESHOLD_PCT;
  }

  function buildSummary(transactions, matchedTrades) {
    const cleanTrades = matchedTrades.filter((m) => !m.isSuspectWindow);
    const suspectTrades = matchedTrades.filter((m) => m.isSuspectWindow);

    const totalTrades = cleanTrades.length;
    const wins = cleanTrades.filter((m) => m.netPnl > 0);
    const losses = cleanTrades.filter((m) => m.netPnl < 0);
    const breakeven = cleanTrades.filter((m) => m.netPnl === 0);

    const winCount = wins.length;
    const lossCount = losses.length;
    const winRate = totalTrades ? winCount / totalTrades : 0.0;

    const realizedPnl = cleanTrades.reduce((s, m) => s + m.netPnl, 0);
    const avgHoldingDays = totalTrades
      ? cleanTrades.reduce((s, m) => s + m.holdingDays, 0) / totalTrades
      : 0.0;

    const avgWin = winCount ? wins.reduce((s, m) => s + m.netPnl, 0) / winCount : 0.0;
    const avgLoss = lossCount ? losses.reduce((s, m) => s + m.netPnl, 0) / lossCount : 0.0;
    const lossSum = losses.reduce((s, m) => s + m.netPnl, 0);
    const winSum = wins.reduce((s, m) => s + m.netPnl, 0);
    const profitFactor = (losses.length && lossSum !== 0) ? winSum / Math.abs(lossSum) : null;

    const bestTrade = cleanTrades.length
      ? cleanTrades.reduce((a, b) => (b.netPnl > a.netPnl ? b : a)) : null;
    const worstTrade = cleanTrades.length
      ? cleanTrades.reduce((a, b) => (b.netPnl < a.netPnl ? b : a)) : null;

    const series = Capital.dailyCapitalSeries(cleanTrades);
    const avgCapital = Capital.timeWeightedAvgCapital(series);
    const [peakCap, peakDate] = Capital.peakCapital(series);
    const medianCap = Capital.medianCapital(series);
    const [latestCap, latestDate] = Capital.latestCapital(series);

    const turnover = Capital.turnoverRatio(transactions, avgCapital);
    const [avgDailyRate, simpleAnnualized] = Capital.capitalOccupancyReturn(cleanTrades);

    const overheldRatio = Capital.overheldCapitalRatio(
      Capital.dailyCapitalBreakdown(cleanTrades, avgHoldingDays)
    );

    const volume = Capital.totalVolume(transactions);
    const feesTax = Capital.totalFeesAndTax(transactions);
    const costRatio = volume ? (feesTax / volume) * 100 : null;

    const daysSpan = series.length ? series[series.length - 1][0] - series[0][0] : 0;

    const returnAvg = Capital.returnOnCapital(realizedPnl, avgCapital);
    const returnAvgAnnual = Capital.annualize(returnAvg, daysSpan);
    const returnPeak = Capital.returnOnCapital(realizedPnl, peakCap);
    const returnPeakAnnual = Capital.annualize(returnPeak, daysSpan);

    return {
      "已實現損益": pyRound(realizedPnl, 0),
      "完整配對交易筆數": totalTrades,
      "勝場": winCount,
      "敗場": lossCount,
      "平盤": breakeven.length,
      "勝率": pyRound(winRate * 100, 1),
      "平均持有天數": pyRound(avgHoldingDays, 1),
      "平均獲利": pyRound(avgWin, 0),
      "平均虧損": pyRound(avgLoss, 0),
      "獲利因子": profitFactor !== null ? pyRound(profitFactor, 2) : null,
      "最大單筆獲利": bestTrade ? pyRound(bestTrade.netPnl, 0) : null,
      "最大單筆獲利股名": bestTrade ? bestTrade.stockName : null,
      "最大單筆虧損": worstTrade ? pyRound(worstTrade.netPnl, 0) : null,
      "最大單筆虧損股名": worstTrade ? worstTrade.stockName : null,

      "時間加權平均占用本金": pyRound(avgCapital, 0),
      "尖峰在場資金": pyRound(peakCap, 0),
      "尖峰在場資金日期": peakDate !== null ? DateUtil.toISO(peakDate) : null,
      "中位數在場資金": pyRound(medianCap, 0),
      "最新在場資金": pyRound(latestCap, 0),
      "最新在場資金日期": latestDate !== null ? DateUtil.toISO(latestDate) : null,
      "雙邊總成交額": pyRound(volume, 0),
      "手續費交易稅合計": pyRound(feesTax, 0),
      "交易成本佔成交額比": costRatio !== null ? pyRound(costRatio, 3) : null,
      "資金週轉率": turnover !== null ? pyRound(turnover, 2) : null,
      "凹單率": overheldRatio !== null ? pyRound(overheldRatio, 1) : null,

      "資金占用報酬率_平均單日": avgDailyRate !== null ? pyRound(avgDailyRate * 100, 3) : null,
      "資金占用報酬率_簡單年化": simpleAnnualized !== null ? pyRound(simpleAnnualized * 100, 1) : null,
      "總獲利率_平均資金": returnAvg !== null ? pyRound(returnAvg, 1) : null,
      "年化獲利率_平均資金": returnAvgAnnual !== null ? pyRound(returnAvgAnnual, 1) : null,
      "總獲利率_尖峰資金": returnPeak !== null ? pyRound(returnPeak, 1) : null,
      "年化獲利率_尖峰資金": returnPeakAnnual !== null ? pyRound(returnPeakAnnual, 1) : null,

      "資料起始日": series.length ? DateUtil.toISO(series[0][0]) : null,
      "資料結束日": series.length ? DateUtil.toISO(series[series.length - 1][0]) : null,
      "排除可疑配對筆數": suspectTrades.length,
    };
  }

  // 各檔損益彙總：只用乾淨（非可疑）的配對交易，依股票分組，依總損益排序
  function buildSymbolSummary(matchedTrades) {
    const cleanTrades = matchedTrades.filter((m) => !m.isSuspectWindow);

    const grouped = new Map();
    for (const m of cleanTrades) {
      const key = `${m.stockCode}|${m.stockName}`;
      if (!grouped.has(key)) grouped.set(key, { code: m.stockCode, name: m.stockName, trades: [] });
      grouped.get(key).trades.push(m);
    }

    const rows = [];
    for (const { code, name, trades } of grouped.values()) {
      const wins = trades.filter((t) => t.netPnl > 0);
      const totalPnl = trades.reduce((s, t) => s + t.netPnl, 0);
      const totalCapital = trades.reduce((s, t) => s + t.occupiedCapital, 0);
      const avgReturnPct = totalCapital ? (totalPnl / totalCapital) * 100 : 0.0;
      const avgHolding = trades.reduce((s, t) => s + t.holdingDays, 0) / trades.length;

      rows.push({
        "股票代號": code,
        "股票名稱": name,
        "交易次數": trades.length,
        "勝場": wins.length,
        "勝率": pyRound((wins.length / trades.length) * 100, 0),
        "總損益": pyRound(totalPnl, 0),
        "平均報酬率": pyRound(avgReturnPct, 2),
        "平均持有天數": pyRound(avgHolding, 1),
      });
    }

    rows.sort((a, b) => b["總損益"] - a["總損益"]);
    return rows;
  }

  // 效益比 Top N：用最少的報酬率%、最少的持有天數，賺到最多總損益的前幾檔股票
  function findBestEfficiencyStocks(symbolRows, topN = 3) {
    const MIN_RETURN_PCT = 0.05;

    const candidates = [];
    for (const row of symbolRows) {
      const totalPnl = row["總損益"];
      const avgReturn = row["平均報酬率"];
      const avgHolding = row["平均持有天數"];

      if (totalPnl <= 0 || avgReturn < MIN_RETURN_PCT) continue;

      const effectiveDays = avgHolding > 0 ? avgHolding : 1.0;
      const ratio = totalPnl / (avgReturn * effectiveDays);
      candidates.push([ratio, row]);
    }

    candidates.sort((a, b) => b[0] - a[0]);

    return candidates.slice(0, topN).map(([ratio, row]) => ({
      "股票代號": row["股票代號"],
      "股票名稱": row["股票名稱"],
      "總損益": row["總損益"],
      "平均報酬率": row["平均報酬率"],
      "平均持有天數": row["平均持有天數"],
      "效益比": pyRound(ratio, 1),
    }));
  }

  // 期末未平倉：目前還沒賣出的庫存
  function buildOpenPositionsRows(openPositions) {
    const totalCost = openPositions.reduce((s, p) => s + p.cost, 0);
    return openPositions.map((p) => {
      const pct = totalCost ? (p.cost / totalCost) * 100 : 0.0;
      return {
        "股票代號": p.stockCode,
        "股票名稱": p.stockName,
        "持有股數": p.quantity,
        "持有成本": pyRound(p.cost, 0),
        "成本均價": pyRound(p.avgPrice, 2),
        "最早買進日": DateUtil.toISO(p.earliestDate),
        "佔未平倉比例": pyRound(pct, 1),
      };
    });
  }

  function capitalSeriesToRows(series) {
    return series.map(([d, v]) => ({ "日期": DateUtil.toISO(d), "在場資金": pyRound(v, 0) }));
  }

  function capitalBreakdownToRows(breakdown) {
    return breakdown.map(([d, total, overheld]) => ({
      "日期": DateUtil.toISO(d),
      "在場資金": pyRound(total, 0),
      "凹單資金": pyRound(overheld, 0),
    }));
  }

  // 彙總「進出場時機」跟「大盤當天漲跌」的整體對應關係，只算乾淨配對
  function buildIndexCorrelationSummary(matchedTrades, indexChangeMap = {}) {
    const cleanTrades = matchedTrades.filter((m) => !m.isSuspectWindow);
    indexChangeMap = indexChangeMap || {};

    const pct = (d) => {
      const info = indexChangeMap[d];
      return info ? info["漲跌百分比"] : null;
    };

    const entryPcts = cleanTrades.map((m) => pct(m.entryDate)).filter((p) => p !== null && p !== undefined);
    const exitPcts = cleanTrades.map((m) => pct(m.exitDate)).filter((p) => p !== null && p !== undefined);

    const entriesOnDownDay = entryPcts.filter((p) => p < 0).length;
    const exitsOnUpDay = exitPcts.filter((p) => p > 0).length;

    const sellFlags = cleanTrades.map((m) => computeSellTooEarly(m.exitDate, indexChangeMap));
    const knownSellFlags = sellFlags.filter((f) => f !== null);
    const sellTooEarlyCount = knownSellFlags.filter((f) => f === true).length;

    return {
      "完整配對交易總筆數": cleanTrades.length,
      "有大盤資料的進場筆數": entryPcts.length,
      "有大盤資料的出場筆數": exitPcts.length,
      "進場日大盤平均漲跌%": entryPcts.length
        ? pyRound(entryPcts.reduce((s, p) => s + p, 0) / entryPcts.length, 2) : null,
      "出場日大盤平均漲跌%": exitPcts.length
        ? pyRound(exitPcts.reduce((s, p) => s + p, 0) / exitPcts.length, 2) : null,
      "進場日為大盤下跌的比例": entryPcts.length
        ? pyRound((entriesOnDownDay / entryPcts.length) * 100, 1) : null,
      "出場日為大盤上漲的比例": exitPcts.length
        ? pyRound((exitsOnUpDay / exitPcts.length) * 100, 1) : null,
      "有賣飛資料的出場筆數": knownSellFlags.length,
      "賣飛筆數": sellTooEarlyCount,
      "賣飛比例": knownSellFlags.length
        ? pyRound((sellTooEarlyCount / knownSellFlags.length) * 100, 1) : null,
      "賣飛門檻天數": SELL_TOO_EARLY_TRADING_DAYS,
      "賣飛門檻漲幅": SELL_TOO_EARLY_THRESHOLD_PCT,
    };
  }

  // 大盤基準損益曲線：跟權益曲線用同一個 x 軸，方便疊圖比較
  function buildBenchmarkCurve(matchedTrades, capitalSeries, indexChangeMap) {
    const cleanTrades = matchedTrades
      .filter((m) => !m.isSuspectWindow)
      .slice()
      .sort((a, b) => (a.exitDate - b.exitDate) || (a.entryDate - b.entryDate));

    if (!cleanTrades.length || !capitalSeries.length || !indexChangeMap
      || Object.keys(indexChangeMap).length === 0) return [];

    const cumulativeByDate = new Map();
    let running = 0.0;
    for (const [d, capital] of capitalSeries) {
      const info = indexChangeMap[d];
      const pctVal = info ? info["漲跌百分比"] : null;
      if (pctVal !== null && pctVal !== undefined) running += (capital * pctVal) / 100;
      cumulativeByDate.set(d, pyRound(running, 0));
    }

    return cleanTrades.map((m) => ({
      "出場日": DateUtil.toISO(m.exitDate),
      "大盤基準損益": cumulativeByDate.has(m.exitDate) ? cumulativeByDate.get(m.exitDate) : null,
    }));
  }

  // 依出場月份彙總（只算乾淨配對）
  function buildMonthlySummary(matchedTrades) {
    const cleanTrades = matchedTrades.filter((m) => !m.isSuspectWindow);

    const grouped = new Map();
    for (const m of cleanTrades) {
      const key = DateUtil.monthKey(m.exitDate);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(m);
    }

    const rows = [];
    for (const monthKey of [...grouped.keys()].sort()) {
      const monthTrades = grouped.get(monthKey);
      const netPnl = monthTrades.reduce((s, t) => s + t.netPnl, 0);
      const wins = monthTrades.filter((t) => t.netPnl > 0);
      rows.push({
        "月份": monthKey,
        "交易次數": monthTrades.length,
        "淨損益": pyRound(netPnl, 0),
        "勝率": pyRound((wins.length / monthTrades.length) * 100, 0),
      });
    }
    return rows;
  }

  // 轉成適合丟到前端表格顯示的格式
  function tradesToRows(matchedTrades, indexChangeMap = {}) {
    indexChangeMap = indexChangeMap || {};
    const pct = (d) => {
      const info = indexChangeMap[d];
      return info ? info["漲跌百分比"] : null;
    };

    return matchedTrades.map((m) => ({
      "股票代號": m.stockCode,
      "股票名稱": m.stockName,
      "方向": m.direction === "long" ? "多單" : "空單(當沖)",
      "進場日": DateUtil.toISO(m.entryDate),
      "出場日": DateUtil.toISO(m.exitDate),
      "配對股數": m.matchedQty,
      "進場價": m.entryPrice,
      "出場價": m.exitPrice,
      "持有天數": m.holdingDays,
      "淨損益": pyRound(m.netPnl, 0),
      "報酬率": pyRound(m.returnPct, 2),
      "可疑配對": m.isSuspectWindow,
      "進場日大盤漲跌%": pct(m.entryDate),
      "出場日大盤漲跌%": pct(m.exitDate),
      "賣飛": computeSellTooEarly(m.exitDate, indexChangeMap),
    }));
  }

  global.Stats = {
    pyRound,
    SELL_TOO_EARLY_TRADING_DAYS, SELL_TOO_EARLY_LOOKAHEAD_CALENDAR_DAYS, SELL_TOO_EARLY_THRESHOLD_PCT,
    sellTooEarlyLookaheadDates, computeSellTooEarly,
    buildSummary, buildSymbolSummary, findBestEfficiencyStocks,
    buildOpenPositionsRows, capitalSeriesToRows, capitalBreakdownToRows,
    buildIndexCorrelationSummary, buildBenchmarkCurve, buildMonthlySummary,
    tradesToRows,
  };
})(typeof window !== "undefined" ? window : global);
