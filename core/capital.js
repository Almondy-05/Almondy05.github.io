/* =========================================================
   資金效率計算
   對應 core/capital.py

   1. 資金週轉率 turnoverRatio
      總成交金額（買進金額 + 賣出金額）÷ 期間內時間加權平均占用本金

   2. 資金占用報酬率 capitalOccupancyReturn
      每筆交易的淨損益 ÷ 該筆交易占用本金 ÷ 持有天數，再取全部交易的
      平均值，另外提供乘以 365 的簡單年化參考值（線性年化，非複利）。

   「時間加權平均占用本金」：把每一筆已配對交易，視為從進場日到出場日
   （含頭尾兩天）持續占用一筆本金，逐日加總所有交易當天占用的本金，
   再除以總天數，得到平均每天實際卡住多少錢。

   逐日序列一律用 [epochDay, value] 的陣列表示（對應 Python 的
   [(date, value), ...]）。
   ========================================================= */
(function (global) {
  "use strict";

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    const mid = Math.floor(n / 2);
    return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // 回傳逐日在場資金序列：[[epochDay, capital], ...]，涵蓋從最早進場日到
  // 最晚出場日的每一天。
  function dailyCapitalSeries(matchedTrades) {
    if (!matchedTrades.length) return [];

    const start = Math.min(...matchedTrades.map((m) => m.entryDate));
    const end = Math.max(...matchedTrades.map((m) => m.exitDate));
    const totalDays = end - start + 1;
    if (totalDays <= 0) return [];

    const dailyCapital = new Array(totalDays).fill(0.0);
    for (const m of matchedTrades) {
      const startIdx = m.entryDate - start;
      const endIdx = m.exitDate - start;
      for (let i = startIdx; i <= endIdx; i++) dailyCapital[i] += m.occupiedCapital;
    }

    return dailyCapital.map((v, i) => [start + i, v]);
  }

  // 跟 dailyCapitalSeries 用同一套日期範圍邏輯，多拆出「凹單」資金：每天的
  // 在場資金裡，有多少是持有超過 overheldThresholdDays 天卻還沒出場的部位。
  // 回傳 [[epochDay, 總在場資金, 凹單資金], ...]
  function dailyCapitalBreakdown(matchedTrades, overheldThresholdDays) {
    if (!matchedTrades.length) return [];

    const start = Math.min(...matchedTrades.map((m) => m.entryDate));
    const end = Math.max(...matchedTrades.map((m) => m.exitDate));
    const totalDays = end - start + 1;
    if (totalDays <= 0) return [];

    const total = new Array(totalDays).fill(0.0);
    const overheld = new Array(totalDays).fill(0.0);
    for (const m of matchedTrades) {
      const startIdx = m.entryDate - start;
      const endIdx = m.exitDate - start;
      for (let i = startIdx; i <= endIdx; i++) {
        total[i] += m.occupiedCapital;
        const daysHeldSoFar = i - startIdx;
        if (daysHeldSoFar > overheldThresholdDays) overheld[i] += m.occupiedCapital;
      }
    }

    return total.map((v, i) => [start + i, v, overheld[i]]);
  }

  // 凹單率：每天的凹單資金加總、除以每天的總在場資金加總（資金 × 天數加權）
  function overheldCapitalRatio(breakdown) {
    if (!breakdown.length) return null;
    const totalSum = breakdown.reduce((s, [, total]) => s + total, 0);
    const overheldSum = breakdown.reduce((s, [, , overheld]) => s + overheld, 0);
    if (totalSum <= 0) return null;
    return (overheldSum / totalSum) * 100;
  }

  function timeWeightedAvgCapital(series) {
    if (!series.length) return 0.0;
    return series.reduce((s, [, v]) => s + v, 0) / series.length;
  }

  // 回傳 [尖峰金額, 發生日 epochDay]
  function peakCapital(series) {
    if (!series.length) return [0.0, null];
    let best = series[0];
    for (const p of series) if (p[1] > best[1]) best = p;
    return [best[1], best[0]];
  }

  function medianCapital(series) {
    if (!series.length) return 0.0;
    return median(series.map(([, v]) => v));
  }

  // 回傳序列最後一天的在場資金 [最新金額, 最新日 epochDay]
  function latestCapital(series) {
    if (!series.length) return [0.0, null];
    const [d, v] = series[series.length - 1];
    return [v, d];
  }

  // 資金週轉率：總成交金額 / 平均占用本金
  function turnoverRatio(transactions, avgCapital) {
    if (avgCapital <= 0) return null;
    return totalVolume(transactions) / avgCapital;
  }

  // 雙邊總成交額：所有委託的（成交股數 × 成交價）加總，買賣都算
  function totalVolume(transactions) {
    return transactions.reduce((s, t) => s + t.quantity * t.price, 0);
  }

  // 手續費 + 交易稅合計（用原始委託明細算，不是配對後的，比較不會有分攤誤差）
  function totalFeesAndTax(transactions) {
    return transactions.reduce((s, t) => s + t.fee + t.tax, 0);
  }

  // 總獲利率：已實現損益 / 某個資金基礎
  function returnOnCapital(realizedPnl, capitalBase) {
    if (capitalBase <= 0) return null;
    return (realizedPnl / capitalBase) * 100;
  }

  // 簡單線性年化：rate_pct * 365 / 資料涵蓋天數（不是複利公式，僅供量級參考）
  function annualize(ratePct, daysSpan) {
    if (ratePct === null || ratePct === undefined || daysSpan <= 0) return null;
    return (ratePct * 365) / daysSpan;
  }

  // 資金占用報酬率：逐筆計算後取平均，回傳 [平均單日報酬率, 簡單年化報酬率]
  function capitalOccupancyReturn(matchedTrades) {
    const rates = [];
    for (const m of matchedTrades) {
      if (m.occupiedCapital <= 0) continue;
      const days = Math.max(m.holdingDays, 1); // 當沖同一天進出，至少以 1 天計
      rates.push(m.netPnl / m.occupiedCapital / days);
    }
    if (!rates.length) return [null, null];
    const avgDailyRate = rates.reduce((s, r) => s + r, 0) / rates.length;
    const simpleAnnualized = avgDailyRate * 365;
    return [avgDailyRate, simpleAnnualized];
  }

  global.Capital = {
    dailyCapitalSeries, dailyCapitalBreakdown, overheldCapitalRatio,
    timeWeightedAvgCapital, peakCapital, medianCapital, latestCapital,
    turnoverRatio, totalVolume, totalFeesAndTax, returnOnCapital,
    annualize, capitalOccupancyReturn, median,
  };
})(typeof window !== "undefined" ? window : global);
