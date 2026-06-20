/* =========================================================
   數字工具：Python 風格的 round()
   ========================================================= */
(function (global) {
  "use strict";

  // Python 的 round() 對浮點數採用「最接近的偶數」規則（banker's rounding），
  // 而且是對這個 double 實際儲存的精確值做正確捨入，不是對「看起來像」的
  // 十進位數字捨入（例如 0.945 在二進位浮點數裡實際存的是
  // 0.9450000000000001，比 0.945 略大一點，所以 Python 會捨入成 0.95，
  // 不會因為「看起來剛好卡在 .5」就觸發四捨五入到偶數）。
  //
  // 這裡用 toPrecision(17) 取出這個 double 完整精確的十進位字串（IEEE754
  // double 最多需要 17 位有效數字才能無損還原），再對字串本身做進位判斷，
  // 避免「先乘以 10^ndigits 再四捨五入」這種做法在乘法過程中產生新的
  // 浮點誤差、反而把原本不是剛好 .5 的數字誤判成剛好 .5。
  function pyRound(value, ndigits = 0) {
    if (value === null || value === undefined) return value;
    if (!isFinite(value)) return value;
    if (value === 0) return 0;

    const sign = value < 0 ? -1 : 1;
    const absValue = Math.abs(value);

    let s = absValue.toPrecision(17);
    if (s.includes("e") || s.includes("E")) {
      // 指數記法（極大或極小的數字），這個專案的金額／百分比量級用不到，
      // 但保留一個安全的退路：轉成一般小數字串
      s = absValue.toFixed(Math.max(ndigits + 20, 20));
    }

    let [intPart, fracPart = ""] = s.split(".");
    while (fracPart.length <= ndigits) fracPart += "0"; // 確保至少多一位可以判斷進位

    const keep = fracPart.slice(0, ndigits);
    const rest = fracPart.slice(ndigits); // 要捨去的部分，用來判斷進位方向

    const digits = (intPart + keep).split("").map(Number);

    const firstRestDigit = rest.charCodeAt(0) - 48;
    const restIsExactlyHalf = firstRestDigit === 5 && /^0*$/.test(rest.slice(1));

    let roundUp;
    if (firstRestDigit > 5 || (firstRestDigit === 5 && !restIsExactlyHalf)) {
      roundUp = true;
    } else if (firstRestDigit < 5) {
      roundUp = false;
    } else {
      // 剛好等於 .5：四捨五入到偶數
      const lastKeptDigit = digits[digits.length - 1];
      roundUp = (lastKeptDigit % 2) === 1;
    }

    if (roundUp) {
      let i = digits.length - 1;
      while (i >= 0) {
        digits[i] += 1;
        if (digits[i] === 10) { digits[i] = 0; i--; } else break;
      }
      if (i < 0) digits.unshift(1);
    }

    const digitsStr = digits.join("");
    const intLen = digitsStr.length - ndigits;
    const finalIntPart = digitsStr.slice(0, intLen) || "0";
    const finalFracPart = ndigits > 0 ? digitsStr.slice(intLen) : "";

    const resultStr = ndigits > 0 ? `${finalIntPart}.${finalFracPart}` : finalIntPart;
    const result = sign * Number(resultStr);
    return result === 0 ? 0 : result; // 避免印出 -0
  }

  global.NumberUtil = { pyRound };
})(typeof window !== "undefined" ? window : global);
