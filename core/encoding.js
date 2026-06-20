/* =========================================================
   檔案編碼偵測

   桌面版（Python）用 utf-8-sig → cp950 → big5 → utf-8 依序嘗試。瀏覽器的
   TextDecoder 沒有 cp950，但 WHATWG Encoding 標準規定瀏覽器都要支援
   'big5'（涵蓋繁體中文網頁最常見的編碼需求），對台灣券商 CSV 來說
   涵蓋範圍幾乎一致，足以取代 cp950。

   策略：
   1. 先看開頭 3 bytes 是不是 UTF-8 BOM（EF BB BF），有的話直接當 UTF-8
      解碼並去掉 BOM。
   2. 沒有 BOM 的話，先嘗試嚴格模式的 UTF-8 解碼（fatal: true），失敗
      （代表不是合法的 UTF-8 位元組序列）就改用 Big5 解碼。
   3. 兩種都解不出來的話（理論上不會發生，Big5 解碼器不會 fatal），
      退而求其次用非嚴格模式的 UTF-8 解碼，亂碼字元用替代符號頂著，
      至少不會讓整個分析流程中斷。
   ========================================================= */
(function (global) {
  "use strict";

  function decodeBytes(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return new TextDecoder("utf-8").decode(bytes.subarray(3));
    }

    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (e) {
      try {
        return new TextDecoder("big5").decode(bytes);
      } catch (e2) {
        return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      }
    }
  }

  async function decodeFileText(file) {
    const buffer = await file.arrayBuffer();
    return decodeBytes(new Uint8Array(buffer));
  }

  global.Encoding = { decodeFileText, decodeBytes };
})(typeof window !== "undefined" ? window : global);
