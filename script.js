// 預設日期為過去一年
function pad(v) { return v.toString().padStart(2, "0"); }
const today = new Date(), lastYear = new Date(today);
lastYear.setFullYear(today.getFullYear() - 1);
document.getElementById("start").value = lastYear.toISOString().slice(0,10);
document.getElementById("end").value = today.toISOString().slice(0,10);
document.getElementById("start").max = today.toISOString().slice(0,10);
document.getElementById("end").max = today.toISOString().slice(0,10);

// *** 存放從所有CSV載入的數據 ***
let csvPriceData = new Map();

// *** 新增：在指令碼載入時，自動從多個 data.csv 檔案獲取並解析數據 ***
(async function loadAllCsvData() {
  const errMsg = document.getElementById("errMsg");

  // 一個輔助函式，用於讀取特定幣種的CSV檔案
  const parseData = async (symbol, filePath) => {
    try {
      const response = await fetch(filePath);
      if (!response.ok) throw new Error(`無法載入 ${filePath}`);
      
      const text = await response.text();
      const lines = text.split('\n');
      let count = 0;
      
      lines.forEach(line => {
        if (!line || line.startsWith('Date')) return;
        const parts = line.split(',');
        if (parts.length < 2) return;
        const dateStr = parts[0].trim();
        const price = parseFloat(parts[1]);
        const key = `price_${symbol}_${dateStr}`;
        csvPriceData.set(key, price);
        count++;
      });
      console.log(`成功從 ${filePath} 自動載入 ${count} 筆 ${symbol} 歷史數據！`);
    } catch (error) {
      console.error(error);
      if (!errMsg.textContent) {
        errMsg.textContent = "部分歷史數據載入失敗，可能影響計算。";
      }
    }
  };

  // 並行載入所有需要的CSV檔案
  await Promise.all([
    parseData("BTCUSDT", "btc_data.csv"),
    parseData("ETHUSDT", "eth_data.csv")
  ]);

  console.log(`總計已載入 ${csvPriceData.size} 筆歷史數據！`);
})();


// 取得所有投資日
function getInvestDates(start, end, freq) {
  const result = [];
  let d = new Date(start.getTime());
  while (d <= end) {
    result.push(new Date(d));
    if (freq === "daily") d.setDate(d.getDate() + 1);
    else if (freq === "weekly") d.setDate(d.getDate() + 7);
    else if (freq === "biweekly") d.setDate(d.getDate() + 14);
    else d.setMonth(d.getMonth() + 1);
  }
  return result;
}

// 升級後的K線獲取函式 (三層查詢邏輯)
async function fetchDayK(symbol, date) {
  const dateString = date.toISOString().slice(0, 10);
  const key = `price_${symbol}_${dateString}`;

  if (csvPriceData.has(key)) return csvPriceData.get(key);
  
  const cachedPrice = localStorage.getItem(key);
  if (cachedPrice) return parseFloat(cachedPrice);

  const start = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const end = start + 86400000;
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&startTime=${start}&endTime=${end}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`API 錯誤，狀態碼: ${resp.status}`);
  const arr = await resp.json();
  if (!Array.isArray(arr) || arr.length === 0) throw new Error(`查無 ${dateString} 的資料`);
  
  const price = parseFloat(arr[0][4]);
  try {
    localStorage.setItem(key, price);
  } catch (e) {
    console.warn("寫入 localStorage 快取失敗。");
  }
  return price;
}

// 初始化圖表
let chart;
function renderChart(labels, values, cost) {
  if (chart) chart.destroy();
  chart = new Chart(document.getElementById("chart").getContext("2d"), {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        { label: "投資組合市值", data: values, fill: true, borderColor: "rgba(0, 184, 212, 1)", backgroundColor: "rgba(0, 184, 212, 0.1)", tension: 0.3 },
        { label: "累積投入金額", data: cost, fill: true, borderColor: "rgba(135, 128, 255, 1)", backgroundColor: "rgba(135, 128, 255, 0.1)", tension: 0.3 }
      ]
    },
    options: {
      plugins: { legend: { display: true, position: 'top' } },
      scales: { x: { display: true }, y: { beginAtZero: true, title: { text: "USD", display: true } } }
    }
  });
}

// 用於暫停的輔助函式
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 點擊計算 (批次處理版本)
document.getElementById("calcBtn").onclick = async function() {
  const symbol = document.querySelector("input[name='coin']:checked").value;
  const amount = parseFloat(document.getElementById("amount").value);
  const freq = document.querySelector("input[name='freq']:checked").value;
  const startStr = document.getElementById("start").value;
  const endStr = document.getElementById("end").value;
  const errMsg = document.getElementById("errMsg");
  errMsg.textContent = "";

  if (!startStr || !endStr) { errMsg.textContent = "請選擇開始與結束日期"; return; }
  const start = new Date(startStr), end = new Date(endStr);
  if (isNaN(start) || isNaN(end) || start >= end) { errMsg.textContent = "日期區間不正確"; return; }
  if (isNaN(amount) || amount <= 0) { errMsg.textContent = "投資金額需大於0"; return; }

  this.disabled = true; this.textContent = "查詢中…";

  try {
    const investDates = getInvestDates(start, end, freq);
    if (investDates.length === 0) throw new Error("此區間無投資日");

    const batchSize = 30;
    const allPriceResults = [];

    for (let i = 0; i < investDates.length; i += batchSize) {
      const currentBatch = investDates.slice(i, i + batchSize);
      const pricePromises = currentBatch.map(d => fetchDayK(symbol, d));
      const batchResults = await Promise.allSettled(pricePromises);
      allPriceResults.push(...batchResults);
    }
    
    let totalInvested = 0, totalCoin = 0;
    const values = [], costArr = [], labels = [];
    let failedQueries = 0;

    for (let i = 0; i < investDates.length; ++i) {
      const result = allPriceResults[i];
      const d = investDates[i];
      let price = 0;
      if (result.status === "fulfilled") {
        price = result.value;
      } else {
        failedQueries++;
        if (values.length > 0 && totalCoin > 0) {
            const lastKnownPrice = values[values.length - 1] / totalCoin;
            values.push(lastKnownPrice * totalCoin);
            costArr.push(totalInvested);
            labels.push(d.toISOString().slice(0, 10));
        }
        continue;
      }
      const coinUnit = amount / price;
      totalInvested += amount;
      totalCoin += coinUnit;
      const value = price * totalCoin;
      values.push(value);
      costArr.push(totalInvested);
      labels.push(d.toISOString().slice(0, 10));
    }

    if (failedQueries > 0) {
        errMsg.textContent = `共有 ${failedQueries} 個日期的資料查詢失敗，已跳過。`;
    }
    if (values.length === 0) { throw new Error("所有日期均查無資料，無法計算。"); }

    const finalValue = values[values.length - 1];
    document.getElementById("totalInvested").textContent = `$${totalInvested.toLocaleString('en-US', {maximumFractionDigits: 2})}`;
    document.getElementById("portfolioValue").textContent = `$${finalValue.toLocaleString('en-US', {maximumFractionDigits: 2})}`;
    const profit = finalValue - totalInvested;
    const profitEl = document.getElementById("profit");
    profitEl.textContent = `$${profit.toLocaleString('en-US', {maximumFractionDigits: 2})}`;
    profitEl.className = profit >= 0 ? "profit" : "loss";
    const rate = totalInvested === 0 ? 0 : profit / totalInvested * 100;
    document.getElementById("performance").textContent = `${rate.toFixed(2)}%`;
    renderChart(labels, values, costArr);
  } catch (e) {
    errMsg.textContent = e.message || "查詢失敗或API繁忙，請稍後再試。";
  }
  
  this.disabled = false; this.textContent = "計算表現";
};