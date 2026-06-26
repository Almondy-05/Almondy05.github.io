/* =========================================================
   資料結構定義
   對應 core/models.py
   Transaction:  從對帳單解析出來的單筆委託成交紀錄
   MatchedTrade: 經過 FIFO 配對後產生的「完整交易」(一買一賣已經對齊)
   OpenPosition: FIFO 配對完之後還沒賣出的庫存部位

   日期欄位一律用 DateUtil 的 epoch day 整數表示，不是 JS Date 物件。
   ========================================================= */
(function (global) {
  "use strict";

  class Transaction {
    constructor({
      stockCode, stockName, tradeDate, action, quantity, price, fee, tax,
      seq, orderId = "", remainingQty = 0,
    }) {
      this.stockCode = stockCode;
      this.stockName = stockName;
      this.tradeDate = tradeDate; // epoch day int
      this.action = action;       // "buy" | "sell"
      this.quantity = quantity;   // 恆為正數
      this.price = price;
      this.fee = fee;
      this.tax = tax;
      this.seq = seq;
      this.orderId = orderId;
      this.remainingQty = remainingQty || quantity;
    }
  }

  class MatchedTrade {
    constructor({
      stockCode, stockName, direction, entryDate, exitDate, matchedQty,
      entryPrice, exitPrice, entryFee, exitFee, exitTax, entryTax = 0.0,
    }) {
      this.stockCode = stockCode;
      this.stockName = stockName;
      this.direction = direction; // "long" | "short"
      this.entryDate = entryDate; // epoch day int
      this.exitDate = exitDate;   // epoch day int
      this.matchedQty = matchedQty;
      this.entryPrice = entryPrice;
      this.exitPrice = exitPrice;
      this.entryFee = entryFee;
      this.exitFee = exitFee;
      this.exitTax = exitTax;
      this.entryTax = entryTax;
    }

    get holdingDays() {
      return DateUtil.diffDays(this.exitDate, this.entryDate);
    }

    get grossPnl() {
      if (this.direction === "long") {
        return (this.exitPrice - this.entryPrice) * this.matchedQty;
      }
      return (this.entryPrice - this.exitPrice) * this.matchedQty; // short：先賣後買，價差方向相反
    }

    get netPnl() {
      return this.grossPnl - this.entryFee - this.exitFee - this.exitTax - this.entryTax;
    }

    // 這筆交易進場當下占用的本金
    get occupiedCapital() {
      return this.entryPrice * this.matchedQty;
    }

    // 這筆交易的報酬率（百分比）
    get returnPct() {
      const capital = this.occupiedCapital;
      return capital ? (this.netPnl / capital) * 100 : 0.0;
    }

    // 現股交易（非融資融券）理論上不可能跨日放空：要嘛當沖（同一天先賣後買），
    // 要嘛一定是先有庫存才能賣。如果配對方向是「空單」但進場日跟出場日不同天，
    // 代表這筆賣出在對帳單涵蓋範圍開始之前就已經持有該股票，配對到的「進場價」
    // 其實是後面一筆不相干的買進，這筆配對的損益數字不可靠，應該排除在主要
    // 統計之外。
    get isSuspectWindow() {
      return this.direction === "short" && this.holdingDays > 0;
    }
  }

  class OpenPosition {
    constructor({ stockCode, stockName, quantity, cost, earliestDate }) {
      this.stockCode = stockCode;
      this.stockName = stockName;
      this.quantity = quantity;
      this.cost = cost;             // 買進總成本
      this.earliestDate = earliestDate; // epoch day int，這部位裡最早買進的那一筆日期
    }

    get avgPrice() {
      return this.quantity ? this.cost / this.quantity : 0.0;
    }
  }

  global.Models = { Transaction, MatchedTrade, OpenPosition };
})(typeof window !== "undefined" ? window : global);
