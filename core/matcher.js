/* =========================================================
   FIFO 配對引擎
   對應 core/matcher.py

   邏輯：
   - 同一檔股票的交易，依成交日期、原始順序排序
   - 買進時：先沖銷掉「未平倉的空單」（先賣後買的當沖放空），沖銷不完的
     剩餘股數變成新的多單未平倉部位
   - 賣出時：先沖銷掉「未平倉的多單」（先買後賣），沖銷不完的剩餘股數
     變成新的空單未平倉部位（當沖先賣後買的情境）
   - 每次沖銷都會依「這次沖銷股數 / 原始該筆委託股數」的比例，分攤手續費
     與交易稅，確保同一筆委託如果被拆成好幾次配對，手續費跟稅不會被
     重複計算或遺漏
   ========================================================= */
(function (global) {
  "use strict";

  function prorate(amount, matchedQty, totalQty) {
    if (totalQty === 0) return 0.0;
    return amount * (matchedQty / totalQty);
  }

  function matchTrades(transactions) {
    const byStock = new Map();
    for (const t of transactions) {
      if (!byStock.has(t.stockCode)) byStock.set(t.stockCode, []);
      byStock.get(t.stockCode).push(t);
    }

    const matchedTrades = [];
    const openPositions = [];

    for (const [stockCode, txs] of byStock) {
      const txsSorted = [...txs].sort((a, b) => (a.tradeDate - b.tradeDate) || (a.seq - b.seq));

      const openLong = [];  // 未平倉多單（buy 但還沒被 sell 沖銷完），用陣列模擬 deque
      const openShort = []; // 未平倉空單（sell 但還沒被 buy 沖銷完，當沖先賣後買）

      for (const t of txsSorted) {
        let remaining = t.quantity;

        if (t.action === "buy") {
          // 先沖掉空單
          while (remaining > 0 && openShort.length > 0) {
            const shortLot = openShort[0];
            const qty = Math.min(remaining, shortLot.remainingQty);

            const entryFee = prorate(shortLot.fee, qty, shortLot.quantity);
            const entryTax = prorate(shortLot.tax, qty, shortLot.quantity);
            const exitFee = prorate(t.fee, qty, t.quantity);
            const exitTax = prorate(t.tax, qty, t.quantity);

            matchedTrades.push(new Models.MatchedTrade({
              stockCode,
              stockName: t.stockName || shortLot.stockName,
              direction: "short",
              entryDate: shortLot.tradeDate,
              exitDate: t.tradeDate,
              matchedQty: qty,
              entryPrice: shortLot.price,
              exitPrice: t.price,
              entryFee, exitFee, exitTax, entryTax,
            }));

            shortLot.remainingQty -= qty;
            remaining -= qty;
            if (shortLot.remainingQty === 0) openShort.shift();
          }

          if (remaining > 0) {
            const newLot = new Models.Transaction({
              stockCode: t.stockCode, stockName: t.stockName,
              tradeDate: t.tradeDate, action: "buy",
              quantity: t.quantity, price: t.price,
              fee: t.fee, tax: t.tax, seq: t.seq,
            });
            newLot.remainingQty = remaining;
            openLong.push(newLot);
          }
        } else { // action === "sell"
          while (remaining > 0 && openLong.length > 0) {
            const longLot = openLong[0];
            const qty = Math.min(remaining, longLot.remainingQty);

            const entryFee = prorate(longLot.fee, qty, longLot.quantity);
            const exitFee = prorate(t.fee, qty, t.quantity);
            const exitTax = prorate(t.tax, qty, t.quantity);

            matchedTrades.push(new Models.MatchedTrade({
              stockCode,
              stockName: t.stockName || longLot.stockName,
              direction: "long",
              entryDate: longLot.tradeDate,
              exitDate: t.tradeDate,
              matchedQty: qty,
              entryPrice: longLot.price,
              exitPrice: t.price,
              entryFee, exitFee, exitTax,
              entryTax: 0.0,
            }));

            longLot.remainingQty -= qty;
            remaining -= qty;
            if (longLot.remainingQty === 0) openLong.shift();
          }

          if (remaining > 0) {
            const newLot = new Models.Transaction({
              stockCode: t.stockCode, stockName: t.stockName,
              tradeDate: t.tradeDate, action: "sell",
              quantity: t.quantity, price: t.price,
              fee: t.fee, tax: t.tax, seq: t.seq,
            });
            newLot.remainingQty = remaining;
            openShort.push(newLot);
          }
        }
      }

      // 這檔股票的交易都處理完了，openLong 裡剩下的就是還沒賣掉的庫存
      if (openLong.length > 0) {
        const totalQty = openLong.reduce((s, lot) => s + lot.remainingQty, 0);
        const totalCost = openLong.reduce((s, lot) => s + lot.remainingQty * lot.price, 0);
        const earliestDate = Math.min(...openLong.map((lot) => lot.tradeDate));
        const stockName = openLong[0].stockName;
        openPositions.push(new Models.OpenPosition({
          stockCode, stockName, quantity: totalQty, cost: totalCost, earliestDate,
        }));
      }
    }

    matchedTrades.sort((a, b) => (a.exitDate - b.exitDate) || (a.entryDate - b.entryDate));
    openPositions.sort((a, b) => b.cost - a.cost);

    return { matchedTrades, openPositions };
  }

  global.Matcher = { matchTrades };
})(typeof window !== "undefined" ? window : global);
