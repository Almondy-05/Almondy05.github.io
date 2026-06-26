/* =========================================================
   AI 點評
   對應 core/commentary.py

   兩條路線：
   1. 規則引擎（buildRuleBasedCommentary）：離線、免費、即時。一組「觸發條件 +
      評語」的規則庫，重點在「交叉判讀」——把多個指標組合起來看出單一指標看不出
      的訊息（例如勝率高但獲利因子普通，暗示少賺多賠）。
   2. LLM 路線（app.js 直接呼叫 Anthropic API）：需連網、需金鑰，能應對規則引擎
      想不到的數據組合。buildLlmPrompt 負責把數據整理成要送給模型的提示文字。

   設計原則：中性客觀、績效跟弱點都講；樣本數少時主動降低確定性；每條規則標上
   分類（整體／亮點／注意／建議）跟優先級，依分類分段、依優先級挑選組合。
   ========================================================= */
(function (global) {
  "use strict";

  // 樣本數門檻：低於這個筆數，所有「比率型」指標都很不穩定，評語要加上但書。
  const SMALL_SAMPLE_THRESHOLD = 30;

  function fmtPct(v, decimals = 1) {
    if (v === null || v === undefined) return "資料不足";
    return `${Number(v).toFixed(decimals)}%`;
  }

  function fmtNum(v) {
    if (v === null || v === undefined) return "—";
    return Number(v).toLocaleString("en-US", { maximumFractionDigits: 0, minimumFractionDigits: 0 });
  }

  // 跑過所有判讀規則，回傳分類好的評語。每個分類是一串 [優先級, 評語]，
  // 優先級小的先呈現。
  function evaluateRules(summary, corr) {
    const sections = { "整體": [], "亮點": [], "注意": [], "建議": [] };

    const get = (k) => summary[k];
    const totalTrades = get("完整配對交易筆數") || 0;
    const winRate = get("勝率");
    const profitFactor = get("獲利因子");
    const avgWin = get("平均獲利");
    const avgLoss = get("平均虧損");
    const expectedValue = get("單筆期望值");
    const realizedPnl = get("已實現損益");
    const sharpe = get("夏普值");
    const sortino = get("索提諾比率");
    const overheld = get("凹單率");
    const avgHolding = get("平均持有天數");
    const turnover = get("資金週轉率");
    const costRatio = get("交易成本佔成交額比");

    const isNum = (v) => v !== null && v !== undefined;
    const smallSample = totalTrades < SMALL_SAMPLE_THRESHOLD;

    // ---- 整體表現 ----
    if (isNum(realizedPnl)) {
      if (realizedPnl > 0) {
        sections["整體"].push([10,
          `這段期間總共完成 ${totalTrades} 筆完整配對交易，已實現損益為正、獲利 ${fmtNum(realizedPnl)} 元。`]);
      } else if (realizedPnl < 0) {
        sections["整體"].push([10,
          `這段期間總共完成 ${totalTrades} 筆完整配對交易，已實現損益為負、虧損 ${fmtNum(Math.abs(realizedPnl))} 元。`]);
      } else {
        sections["整體"].push([10,
          `這段期間總共完成 ${totalTrades} 筆完整配對交易，整體損益接近損平。`]);
      }
    }

    // 樣本數但書放在整體段最前面（優先級最小），定調整段點評的可信度
    if (smallSample && totalTrades > 0) {
      sections["整體"].unshift([5,
        `先說明一個前提：目前只有 ${totalTrades} 筆交易，樣本數偏少，下面提到的` +
        `勝率、獲利因子、夏普值這類比率型指標都還不穩定，一兩筆極端的交易就會` +
        `讓數字大幅跳動，這裡的判讀比較像是初步觀察，不是穩定的結論。`]);
    }

    // ---- 勝率 × 獲利因子的交叉判讀 ----
    if (isNum(winRate) && isNum(profitFactor)) {
      if (winRate >= 70 && profitFactor < 1.5) {
        sections["注意"].push([20,
          `勝率高達 ${fmtPct(winRate)}，獲利因子卻只有 ${profitFactor.toFixed(2)}，` +
          `這個組合值得注意：勝率高代表常常賺，獲利因子不高代表「賺的時候賺得少、` +
          `賠的時候賠得多」。對照平均獲利 ${fmtNum(avgWin)}、平均虧損 ${fmtNum(avgLoss)}，` +
          `可能有太早獲利了結、或停損放得太鬆的傾向。`]);
        sections["建議"].push([20,
          `獲利因子 = 總獲利 ÷ 總虧損。現在勝率夠高，瓶頸在「賺賠比」` +
          `（平均獲利 ${fmtNum(avgWin)} 對平均虧損 ${fmtNum(avgLoss)}）。` +
          `可以朝兩個方向調：獲利單別太早跑、讓會賺的單多抱一段（拉高平均獲利），` +
          `虧損單把停損點收緊一點（壓低平均虧損）。賺賠比拉開，就算勝率略降，` +
          `獲利因子通常也會明顯改善。`]);
      } else if (winRate >= 70 && profitFactor >= 2.5) {
        sections["亮點"].push([20,
          `勝率 ${fmtPct(winRate)} 搭配獲利因子 ${profitFactor.toFixed(2)}，是相當` +
          `健康的組合：不只常常賺，而且賺的幅度明顯大過賠的幅度，賺賠比控制得宜。`]);
      } else if (winRate < 50 && isNum(profitFactor) && profitFactor >= 1.5) {
        sections["亮點"].push([20,
          `勝率 ${fmtPct(winRate)}、不到一半，獲利因子卻有 ${profitFactor.toFixed(2)}，` +
          `代表這是「大賺小賠」的型態：贏的次數少，每次賺的幅度大、賠的幅度小。` +
          `這種型態的紀律性（讓獲利奔跑、虧損快砍），實務上比高勝率更難做到。`]);
      }
    }

    // ---- 單筆期望值 ----
    if (isNum(expectedValue)) {
      if (expectedValue > 0) {
        sections["整體"].push([15,
          `平均每筆交易的期望值是 +${fmtNum(expectedValue)} 元，長期下來每多做` +
          `一筆同樣性質的交易，期望上是加分的。`]);
      } else {
        sections["注意"].push([15,
          `平均每筆交易的期望值是 ${fmtNum(expectedValue)} 元、為負，代表以這段` +
          `期間的型態，每多做一筆交易期望上是扣分的，要留意是不是進出場的條件` +
          `需要收緊。`]);
        sections["建議"].push([15,
          `單筆期望值 = 勝率 × 平均獲利 − 敗率 × 平均虧損。現在為負，三個槓桿` +
          `都可以檢視：提高勝率（進場條件更嚴、只做勝算高的型態）、拉高平均獲利` +
          `（會賺的單多抱）、降低平均虧損（停損更果斷）。先從最弱的那一項下手` +
          `通常最有效，建議對照勝率跟賺賠比，看是哪一項把期望值拖到負的。`]);
      }
    }

    // ---- 夏普值 × 索提諾比率的落差判讀 ----
    if (isNum(sharpe) && isNum(sortino) && sharpe > 0) {
      const ratio = sharpe > 0 ? sortino / sharpe : 0;
      if (ratio >= 2.0) {
        sections["亮點"].push([30,
          `索提諾比率（${sortino.toFixed(2)}）明顯高於夏普值（${sharpe.toFixed(2)}），兩者落差大` +
          `通常是好事：代表報酬的波動主要來自獲利那一側，向下的波動（虧損）相對` +
          `受控，沒有出現失控的大虧。`]);
      } else if (ratio < 1.2) {
        sections["注意"].push([30,
          `索提諾比率（${sortino.toFixed(2)}）跟夏普值（${sharpe.toFixed(2)}）很接近，代表向下的` +
          `波動在整體波動裡占比不低，虧損端的起伏值得留意。`]);
      }
    }

    // ---- 夏普值偏低：用公式拆解給改善方向 ----
    if (isNum(sharpe)) {
      if (sharpe < 0.5) {
        sections["注意"].push([35,
          `夏普值 ${sharpe.toFixed(2)} 偏低，代表「每承受一單位報酬波動，換到的超額` +
          `報酬」不高，報酬相對於它的起伏不夠突出。`]);
        sections["建議"].push([35,
          `夏普值 =（平均報酬率 − 無風險利率）÷ 報酬率的標準差，要提升就從` +
          `分子、分母兩邊著手：分子方面，提高每筆交易的平均報酬（賺賠比拉開、` +
          `少做勝算低的單）；分母方面，壓低報酬的「忽高忽低」——交易品質參差` +
          `（有時大賺有時大賠）會把標準差墊高、稀釋夏普值，讓每筆報酬更穩定、` +
          `砍掉那些風險報酬不對稱的衝動單，分母降下來夏普值就會上來。`]);
      }
    }

    // ---- 凹單率 ----
    if (isNum(overheld) && isNum(avgHolding)) {
      if (overheld >= 40) {
        sections["注意"].push([40,
          `凹單率 ${fmtPct(overheld)} 偏高，代表有相當比例的資金，卡在持有超過` +
          `平均天數（${avgHolding.toFixed(1)} 天）還沒出場的部位上。短線策略裡這通常是` +
          `「不甘心認賠、硬凹等解套」的訊號，會壓低資金周轉效率，值得檢視那些` +
          `凹比較久的部位是不是該處理。`]);
        sections["建議"].push([40,
          `凹單率是「資金 × 天數」加權算出來的，凹愈久、金額愈大，對它的拉抬` +
          `愈明顯。改善方向是設一條紀律線：部位持有天數一超過平均（${avgHolding.toFixed(1)} 天）` +
          `就強制重新檢視，符合出場條件就出、別等解套。把少數凹很久的大部位處理掉，` +
          `凹單率會降得最快，卡住的資金也能釋放出來周轉。`]);
      } else if (overheld <= 15) {
        sections["亮點"].push([40,
          `凹單率只有 ${fmtPct(overheld)}，資金大多在預期的持有天數內就完成` +
          `周轉，沒有明顯凹單拖延的情況，這對短線策略是好的紀律表現。`]);
      }
    }

    // ---- 交易成本：高周轉的隱形殺手 ----
    if (isNum(costRatio) && isNum(turnover)) {
      if (turnover >= 5 && costRatio >= 0.3) {
        sections["注意"].push([50,
          `資金週轉率 ${turnover.toFixed(1)} 偏高、交易頻繁，搭配交易成本佔成交額 ` +
          `${fmtPct(costRatio, 2)}，要留意手續費跟稅這類交易成本的累積侵蝕，` +
          `高頻周轉之下這部分會比想像中吃掉更多獲利。`]);
        sections["建議"].push([50,
          `交易成本佔比 =（手續費 + 交易稅）÷ 雙邊總成交額，這個比例靠單筆很難壓，` +
          `高周轉會讓它一直累積。建議減少「為動而動」的交易，把資金集中在勝算` +
          `比較高的機會上（提高每筆的質、降低筆數），周轉次數少了，被成本吃掉的` +
          `獲利就少了。另外確認手續費折讓有沒有談到比較好的條件。`]);
      }
    }

    // ---- 大盤對應分析 ----
    if (corr) {
      const entryBias = corr["進場日平均乖離%"];
      const exitBias = corr["出場日平均乖離%"];
      const sellTooEarly = corr["賣飛比例"];
      const entriesOnDown = corr["進場日為大盤下跌的比例"];

      if (isNum(entryBias) && isNum(exitBias)) {
        if (exitBias - entryBias >= 1.5) {
          const base =
            `進場日大盤平均乖離 ${fmtPct(entryBias, 2)}、出場日 ${fmtPct(exitBias, 2)}，` +
            `出場時大盤明顯比進場時偏熱，傾向在大盤相對強勢的時候賣出。`;
          if (isNum(sellTooEarly) && sellTooEarly <= 20) {
            sections["亮點"].push([60,
              base + `而且賣飛比例只有 ${fmtPct(sellTooEarly)}，` +
              `事後看大多賣在相對高點、沒有太常賣太早，出場時機掌握得不錯。`]);
          } else if (isNum(sellTooEarly) && sellTooEarly >= 30) {
            sections["注意"].push([60,
              base + `只是賣飛比例有 ${fmtPct(sellTooEarly)}偏高，` +
              `代表不少時候賣出後大盤又繼續往上，可能有出場太早、少賺一段的情況。`]);
            sections["建議"].push([60,
              `賣飛比例高，是出場規則太早觸發。可以考慮：上漲過程中改用「移動停利」` +
              `（價格沿著均線或前一日低點往上墊，跌破才出）取代固定獲利點，讓會繼續` +
              `漲的部位多跑一段；或把出場拆成兩批，一批先獲利了結、一批留著續抱，` +
              `兼顧落袋跟少賣飛。`]);
          } else {
            sections["整體"].push([60, base]);
          }
        }
      }

      if (isNum(entriesOnDown) && entriesOnDown >= 60) {
        sections["亮點"].push([65,
          `有 ${fmtPct(entriesOnDown)} 的進場日落在大盤下跌的日子，偏向` +
          `「逢相對低點承接」而不是追高，這在多頭環境裡是比較不會追在高點的進場節奏。`]);
      }
    }

    return sections;
  }

  // 規則引擎點評對外入口。回傳 { mode:"rule", paragraphs:[...] }
  function buildRuleBasedCommentary(summary, corr = null) {
    const totalTrades = (summary["完整配對交易筆數"]) || 0;
    if (totalTrades === 0) {
      return { mode: "rule", paragraphs: ["目前沒有完整配對的交易，無法產生點評。等累積一些交易紀錄再回來看看。"] };
    }

    const sections = evaluateRules(summary, corr);
    const paragraphs = [];

    const sortByPriority = (arr) => [...arr].sort((a, b) => a[0] - b[0]).map((x) => x[1]);

    const overall = sortByPriority(sections["整體"]);
    if (overall.length) paragraphs.push(overall.join(""));

    const highlights = sortByPriority(sections["亮點"]).slice(0, 3);
    if (highlights.length) paragraphs.push("【表現不錯的地方】" + highlights.join(""));

    const concerns = sortByPriority(sections["注意"]).slice(0, 3);
    if (concerns.length) paragraphs.push("【值得注意的地方】" + concerns.join(""));

    const suggestions = sortByPriority(sections["建議"]).slice(0, 3);
    if (suggestions.length) paragraphs.push("【可以改善的方向】" + suggestions.join(""));

    paragraphs.push("（以上是根據對帳單數據的程式化判讀，僅供回顧檢視參考，不構成投資建議。）");

    return { mode: "rule", paragraphs };
  }

  // 把指標數據整理成要送給 LLM 的提示文字
  function buildLlmPrompt(summary, corr = null) {
    const totalTrades = (summary["完整配對交易筆數"]) || 0;

    const lines = [
      "你是一位資深的短線交易檢視者。下面是一位台股短線交易者，根據券商對帳單",
      "自動算出來的績效指標跟大盤對應數據。請用繁體中文（嚴禁簡體字）寫一段點評，",
      "中性、客觀，不要過度吹捧也不要危言聳聽。",
      "",
      "請照這個結構分四段（每段都務必扣著下面實際的數字講，不要講空泛的通則）：",
      "1.【整體】這段期間整體表現的定調，帶出最關鍵的兩三個數字。",
      "2.【表現不錯的地方】用交叉判讀找出真正的亮點（把兩三個指標組合起來看，",
      "   例如夏普值跟索提諾比率的落差、勝率搭配獲利因子），不要每個指標各誇一句。",
      "3.【值得注意的地方】同樣用交叉判讀點出弱點，講清楚為什麼這是弱點。",
      "4.【可以改善的方向】這段最重要：針對上一段每個弱點，根據該指標的「計算公式」",
      "   給出具體、可操作的改善方向。例如夏普值 =（平均報酬 − 無風險利率）÷ 報酬",
      "   標準差，要提升就從「拉高平均報酬」或「降低報酬波動」兩個方向講；獲利因子 =",
      "   總獲利 ÷ 總虧損，就從賺賠比著手。建議要扣著公式、講得出「動哪個變數、怎麼動」，",
      "   不要只說「加強紀律」這種空話。",
      "",
      "其他要求：篇幅由上面的內容自然決定，重點是每句話都要有料、別灌水湊字數；",
      "不要用對比句型（例如「不是…而是」「雖然…但是」）；如果交易筆數少於 30 筆，",
      "請在開頭主動提醒這些比率型指標還不穩定、只是初步觀察；結尾註明這不構成投資建議。",
      "",
      "=== 核心績效 ===",
      `完整配對交易筆數：${totalTrades}`,
      `已實現損益：${fmtNum(summary["已實現損益"])} 元`,
      `勝率：${fmtPct(summary["勝率"])}`,
      `獲利因子：${summary["獲利因子"]}`,
      `單筆期望值：${fmtNum(summary["單筆期望值"])} 元`,
      `平均獲利：${fmtNum(summary["平均獲利"])} 元`,
      `平均虧損：${fmtNum(summary["平均虧損"])} 元`,
      `平均持有天數：${summary["平均持有天數"]} 天`,
      `夏普值：${summary["夏普值"]}（資金占用日報酬率、未年化）`,
      `索提諾比率：${summary["索提諾比率"]}`,
      `凹單率：${fmtPct(summary["凹單率"])}`,
      `資金週轉率：${summary["資金週轉率"]}`,
      `交易成本佔成交額比：${fmtPct(summary["交易成本佔成交額比"], 2)}`,
    ];

    if (corr) {
      lines.push(
        "",
        "=== 大盤對應分析 ===",
        `進場日大盤平均漲跌%：${fmtPct(corr["進場日大盤平均漲跌%"], 2)}`,
        `出場日大盤平均漲跌%：${fmtPct(corr["出場日大盤平均漲跌%"], 2)}`,
        `進場日為大盤下跌的比例：${fmtPct(corr["進場日為大盤下跌的比例"])}`,
        `出場日為大盤上漲的比例：${fmtPct(corr["出場日為大盤上漲的比例"])}`,
        `賣飛比例：${fmtPct(corr["賣飛比例"])}`,
        `進場日平均乖離%：${fmtPct(corr["進場日平均乖離%"], 2)}`,
        `出場日平均乖離%：${fmtPct(corr["出場日平均乖離%"], 2)}`
      );
    }

    return lines.join("\n");
  }

  global.Commentary = {
    SMALL_SAMPLE_THRESHOLD,
    buildRuleBasedCommentary, buildLlmPrompt,
  };
})(typeof window !== "undefined" ? window : global);
