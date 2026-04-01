import { StarkZap, OnboardStrategy } from "starkzap";
import "./style.css";

// ═══════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════
const CONTRACT_ADDRESS = "0x022ea9520daa775d9e0dabe6e7fd3c62f3b3e427850609c6b7295d5a8670fe35";
let starkZapSdk = null;
let userWallet = null;

const PAIRS = {
  'BTC/USDT':{wsSymbol: 'btcusdt'},
};

let rowStep = 0; // unused now, kept for compatibility

const CELL_W   = 150;      // px per column
const CELL_H   = 90;       // px per row
const INITIAL_ROWS = 25;   // initial visible price rows
const MIN_ROWS = 20;       // minimum rows when shrinking
const COL_SEC  = 5;        // seconds per column
const TICK_MS  = 80;       // price tick interval
const TICK_SIZE = 1;       // $1 per row
const NOW_SCREEN_FRAC = 0.28; // NOW line sits 28% from left of viewport
const FUTURE_COLS = 10;    // how many future columns always visible
const FADE_COLS   = 4;     // columns behind NOW that fade out

// ═══════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════
let activePair = 'BTC/USDT';
let price, priceStart, rowPrices = [];
let lives = 3, score = 0, stake = 1;
let tickCount = 0;             // total ticks elapsed
let gameTime  = 0;             // seconds elapsed (float)
let priceHistory = [];         // [{t, price}] — t in seconds
let placedBets = new Map();    // key = `${col},${row}` → bet obj

// Dynamic price axis state
let numRows = INITIAL_ROWS;
let gridOffsetY = 0;
let targetGridOffsetY = 0;

// canvas / DOM refs
let mainCanvas, mainCtx;
let timebarCanvas, timebarCtx;
let scrollArea, cellLayer;
let animFrame;
let gameLoop;

// viewport info
let vpW, vpH;                  // scroll-area dimensions
let nowX;                      // px: where NOW line sits on screen

// column tracking
let firstColTime = -FADE_COLS * COL_SEC; // time (s) of the leftmost rendered column
let renderedCols = new Map();  // colIndex → DOM column div

// optimization caches
let lastColUpdate = 0;

// WebSocket state
let ws = null;
let wsReconnectTimer = null;
let lastWsPrice = null;
let useSimulatedPrice = false;
const COL_UPDATE_INTERVAL = 16; // ~60fps throttling

// Cached gradients for performance
let fadeGradient = null;
let lineGradient = null;

// ═══════════════════════════════════════════════
//  WEBSOCKET
// ═══════════════════════════════════════════════
function connectWebSocket(pair){
  disconnectWebSocket();
  
  const pd = PAIRS[pair];
  if(!pd || !pd.wsSymbol) return;
  
  // Use @aggTrade for faster price updates (every trade vs 1 second)
  const wsUrl = `wss://stream.binance.com:9443/ws/${pd.wsSymbol}@aggTrade`;
  
  ws = new WebSocket(wsUrl);
  
  ws.onopen = () => {
    useSimulatedPrice = false;
    console.log('WebSocket connected for', pair, '(aggTrade - fast updates)');
  };

  let lastLogTime = 0;
  ws.onmessage = (event) => {
    try {
      // Handle ping from server (must respond within 60s per Binance docs)
      if (event.data === 'ping') {
        ws.send('pong');
        return;
      }
      
      const data = JSON.parse(event.data);
      // @aggTrade format: { "s": "BTCUSDT", "p": "65432.10", "q": "0.100" }
      if(data.s && data.p){
        const parsedP = parseFloat(data.p);
        
        // Debug log so user can verify frequency
        const now = Date.now();
        if (now - lastLogTime > 3000) {
          console.log(`[WS] Real-time price update for ${data.s} parsed: $${parsedP}`);
          lastLogTime = now;
        }

        // If this is the first real price and it's severely disconnected from our fallback (e.g., >20 rows off)
        // snap the entire grid instantly rather than dragging the camera and generating thousands of DOM rows.
        if (lastWsPrice === null && Math.abs(parsedP - price) > TICK_SIZE * 20) {
            price = parsedP;
            lastWsPrice = parsedP;
            console.log(`[WS] Snapping grid to actual venue price: $${parsedP}`);
            updatePriceAxis(true);
        } else {
            lastWsPrice = parsedP;
        }
      }
    } catch(e){}
  };
  
  ws.onerror = (err) => {
    console.warn('WebSocket error:', err);
  };
  
  ws.onclose = () => {
    console.log('WebSocket disconnected. Will try to reconnect in 3 seconds...');
    ws = null;
    wsReconnectTimer = setTimeout(() => connectWebSocket(pair), 3000);
  };
}

function disconnectWebSocket(){
  if(ws){
    ws.close();
    ws = null;
  }
  if(wsReconnectTimer){
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
}

function getScoreKey() {
  if (userWallet) {
    const addr = userWallet?.account?.address || userWallet?.address || userWallet?.selectedAddress;
    if (addr) return 'ctrush_score_' + addr;
  }
  return 'ctrush_score';
}

function loadScore() {
  score = parseInt(localStorage.getItem(getScoreKey())) || 0;
  document.getElementById('tb-score').textContent = score;
}

function saveScore() {
  localStorage.setItem(getScoreKey(), score);
  document.getElementById('tb-score').textContent = score;
}

// ═══════════════════════════════════════════════
//  INIT / RESIZE
// ═══════════════════════════════════════════════
async function init(pair, initialPrice){
  activePair = pair;
  const pd = PAIRS[pair];
  const live = initialPrice !== undefined ? initialPrice : 65000; // default fallback
  price = live; priceStart = live;

  lives = 3; loadScore(); tickCount = 0; gameTime = 0;
  priceHistory = [];
  placedBets.clear();
  renderedCols.clear();
  firstColTime = -FADE_COLS * COL_SEC;
  renderLives();
  updateTopBar();

  scrollArea  = document.getElementById('scroll-area');
  cellLayer   = document.getElementById('cell-layer');
  cellLayer.innerHTML = '';

  mainCanvas  = document.getElementById('main-canvas');
  mainCtx     = mainCanvas.getContext('2d');
  timebarCanvas = document.getElementById('timebar-canvas');
  timebarCtx    = timebarCanvas.getContext('2d');

  onResize();
  updatePriceAxis(true);
  ensureColumns(0);

  connectWebSocket(pair);

  clearInterval(gameLoop);
  cancelAnimationFrame(animFrame);
  gameLoop = setInterval(tickPrice, TICK_MS);
  drawLoop(0);
}

function onResize(){
  if (!scrollArea) return;
  vpW = scrollArea.offsetWidth;
  vpH = scrollArea.offsetHeight;
  nowX = vpW * NOW_SCREEN_FRAC;
  mainCanvas.width  = vpW; mainCanvas.height = vpH;
  timebarCanvas.width  = document.querySelector('.timebar').offsetWidth;
  timebarCanvas.height = document.querySelector('.timebar').offsetHeight;
  
  // Expand grid gracefully if viewport grows dramatically
  const neededHalf = Math.ceil(vpH / CELL_H) + 2;
  if (neededHalf * 2 + 1 > numRows && rowPrices.length > 0) {
     // manageDynamicRows handles the missing rows via infinite generation!
  } else if (rowPrices.length === 0) {
     updatePriceAxis(true);
  }
}
window.addEventListener('resize', () => { onResize(); buildPriceAxis(); });

// ═══════════════════════════════════════════════
//  PRICE ROWS
// ═══════════════════════════════════════════════
function updatePriceAxis(force = false){
  if (rowPrices.length === 0 || force) {
    rowPrices = [];
    const centerPrice = price;
    const neededHalf = Math.ceil(vpH / CELL_H) + 2; 
    for(let i = -neededHalf; i <= neededHalf; i++){
      rowPrices.push(centerPrice - i * TICK_SIZE);
    }
    numRows = rowPrices.length;
    gridOffsetY = vpH / 2 - (neededHalf * CELL_H + CELL_H / 2);
    targetGridOffsetY = gridOffsetY;
    
    buildPriceAxis();
    rebuildAllCells();
  }
}

function rebuildAllCells(){
  cellLayer.style.top = `${gridOffsetY}px`;
  cellLayer.style.height = `${numRows * CELL_H}px`;
  
  renderedCols.forEach((colEl, idx) => {
    const colTime = colIndexToTime(idx);
    const isPast = colTime < gameTime;
    
    colEl.style.height = `${numRows * CELL_H}px`;
    colEl.innerHTML = '';
    for(let r = 0; r < numRows; r++){
      const cell = createCell(r, idx, colTime, isPast);
      colEl.appendChild(cell);
    }
  });
}

function priceToY(p){
  if (!rowPrices.length) return 0;
  const i = (rowPrices[0] - p) / TICK_SIZE;
  return i * CELL_H + CELL_H / 2 + gridOffsetY;
}

function yToRow(y){
  const y_grid = y - gridOffsetY;
  return Math.max(0, Math.min(rowPrices.length - 1, Math.floor(y_grid / CELL_H)));
}

function rowToY(r){ 
  return r * CELL_H + gridOffsetY; 
}

// ═══════════════════════════════════════════════
//  PRICE AXIS
// ═══════════════════════════════════════════════
function createAxisLabel(p) {
  const lbl = document.createElement('div');
  lbl.className = 'pa-lbl';
  lbl.textContent = fmtPrice(p);
  return lbl;
}

function updatePriceAxisLabels() {
  const body = document.getElementById('pa-body');
  const labels = body.children;
  
  let closestIndex = 0;
  let minDiff = Infinity;
  for(let i = 0; i < rowPrices.length; i++){
    const diff = Math.abs(rowPrices[i] - price);
    if (diff < minDiff) { minDiff = diff; closestIndex = i; }
  }

  for(let i = 0; i < labels.length; i++){
    labels[i].style.top = (i * CELL_H + CELL_H / 2 + gridOffsetY) + 'px';
    if(i === closestIndex) {
      if(!labels[i].classList.contains('current')) labels[i].classList.add('current');
    } else {
      if(labels[i].classList.contains('current')) labels[i].classList.remove('current');
    }
  }
}

function buildPriceAxis(){
  const body = document.getElementById('pa-body');
  body.innerHTML = '';
  rowPrices.forEach((p, i) => {
    const lbl = createAxisLabel(p);
    body.appendChild(lbl);
  });
  updatePriceAxisLabels();
}

function updateCellPrices(){
  renderedCols.forEach((colEl, idx) => {
    const cells = colEl.children;
    for(let r = 0; r < cells.length; r++){
      const cell = cells[r];
      const targetPrice = rowPrices[r];
      const bpsDiff = ((targetPrice - price) / price * 10000).toFixed(2);
      const priceEl = cell.querySelector('div:first-child');
      const bpsEl = cell.querySelector('div:last-child');
      if(priceEl) priceEl.textContent = fmtPriceFull(targetPrice);
      if(bpsEl) bpsEl.textContent = `${bpsDiff >= 0 ? '+' : ''}${bpsDiff} bps`;
    }
  });
}

// ═══════════════════════════════════════════════
//  COLUMN MANAGEMENT — infinite
// ═══════════════════════════════════════════════
// colIndex 0 = the column whose time = firstColTime
// columns are DOM divs absolutely positioned in cellLayer

function colTimeToIndex(t){
  return Math.round((t - firstColTime) / COL_SEC);
}

function colIndexToTime(idx){
  return firstColTime + idx * COL_SEC;
}

// Convert a column's time to screen X
function timeToScreenX(t){
  return nowX + (t - gameTime) / COL_SEC * CELL_W;
}

function ensureColumns(now){
  if (now - lastColUpdate < COL_UPDATE_INTERVAL) return;
  lastColUpdate = now;

  const leftTime  = gameTime - FADE_COLS * COL_SEC;
  const rightTime = gameTime + FUTURE_COLS * COL_SEC;
  const leftIdx   = Math.floor((leftTime  - firstColTime) / COL_SEC);
  const rightIdx  = Math.ceil ((rightTime - firstColTime) / COL_SEC);

  for(let idx = Math.max(0, leftIdx); idx <= rightIdx; idx++){
    if(!renderedCols.has(idx)) createColumn(idx);
  }

  renderedCols.forEach((colEl, idx) => {
    if(idx < leftIdx - 2){
      colEl.remove();
      renderedCols.delete(idx);
    }
  });

  renderedCols.forEach((colEl, idx) => {
    const t = colIndexToTime(idx);
    const x = timeToScreenX(t);
    colEl.style.transform = `translate3d(${x}px, 0, 0)`;

    const secsBehind = gameTime - t;
    if(secsBehind > 0){
      const fadeFrac = Math.min(1, secsBehind / (FADE_COLS * COL_SEC));
      colEl.style.opacity = Math.max(0, 1 - fadeFrac * 1.3).toFixed(3);
      colEl.style.pointerEvents = 'none';
    } else {
      colEl.style.opacity = '1';
      colEl.style.pointerEvents = '';
    }
  });
}

function createColumn(idx){
  const colTime = colIndexToTime(idx);
  const isPast  = colTime < gameTime;

  const colEl = document.createElement('div');
  colEl.className = 'grid-column';
  colEl.style.width = `${CELL_W}px`;
  colEl.style.height = `${numRows * CELL_H}px`;
  colEl.dataset.idx = idx;

  for(let r = 0; r < numRows; r++){
    const cell = createCell(r, idx, colTime, isPast);
    colEl.appendChild(cell);
  }

  cellLayer.appendChild(colEl);
  renderedCols.set(idx, colEl);
}

function createCell(row, colIdx, colTime, isPast){
  const targetPrice = rowPrices[row];
  // Calculate relative to live price during cell generation
  const distInTicks = Math.round((targetPrice - price) / TICK_SIZE); 
  const isUp = distInTicks >= 0;
  const absDist = Math.abs(distInTicks);
  const timeDist = Math.abs(colTime - gameTime) / COL_SEC;

  let bg;
  if(isPast){
    bg = 'rgba(0,0,0,0.03)';
  } else {
    bg = 'rgba(245,235,220,0.5)';
  }

  const mult = calcMult(absDist, timeDist);
  const payout = (stake * mult).toFixed(2);
  const bpsDiff = ((targetPrice - price) / price * 10000).toFixed(2);

  const cell = document.createElement('div');
  cell.className = 'grid-cell' + (isPast ? ' past' : '');
  cell.style.background = bg;
  cell.dataset.row = row;
  cell.dataset.col = colIdx;
  cell.dataset.mult = mult;
  cell.dataset.payout = payout;
  cell.dataset.time = colTime;
  cell.dataset.isUp = isUp ? '1' : '0';
  cell.dataset.targetPrice = targetPrice;

  const key = `${colIdx},${targetPrice.toFixed(4)}`;
  const bet = placedBets.get(key);

  if (bet && !bet.resolved) {
      cell.dataset.placed = '1';
      cell.style.background = 'rgba(245,197,24,0.12)';
      cell.style.outline = '1.5px solid rgba(245,197,24,0.6)';
      cell.style.outlineOffset = '-1px';
  }

  const priceEl = document.createElement('div');
  priceEl.style.cssText = `font-size:13px;font-weight:700;color:${isPast?'rgba(0,0,0,0.25)':isUp?'rgba(0,168,84,0.9)':'rgba(234,57,67,0.9)'};`;
  if (bet && !bet.resolved) {
      priceEl.style.color = 'rgba(245,197,24,0.9)';
  }
  priceEl.textContent = fmtPriceFull(targetPrice);
  priceEl.className = 'cell-price';

  const bpsEl = document.createElement('div');
  bpsEl.style.cssText = `font-size:10px;color:rgba(0,0,0,0.35);`;
  bpsEl.textContent = `${bpsDiff >= 0 ? '+' : ''}${bpsDiff} bps`;
  bpsEl.className = 'cell-bps';

  cell.appendChild(priceEl);
  cell.appendChild(bpsEl);

  if(!isPast){
    cell.addEventListener('mouseenter', () => {
      if(!cell.dataset.placed) cell.style.background = 'rgba(220,200,175,0.6)';
    });
    cell.addEventListener('mouseleave', () => {
      if(!cell.dataset.placed) cell.style.background = bg;
    });
    cell.addEventListener('click', () => placeBet(row, colIdx, cell, mult, colTime, isUp));
  }

  return cell;
}

function calcMult(priceDist, timeDist){
  const base = 1.1 + priceDist * 0.9 + timeDist * 0.6;
  return Math.min(33, parseFloat(base.toFixed(1)));
}

// ═══════════════════════════════════════════════
//  PLACE BET
// ═══════════════════════════════════════════════
function placeBet(row, colIdx, cell, mult, colTime, isUp){
  if (window.innerWidth <= 768) {
    showToast("Use Desktop/Tablet to place bets!", "info");
    return;
  }
  if (!userWallet) {
    showToast("Please Connect Wallet first!", "info");
    return;
  }

  const targetPrice = parseFloat(cell.dataset.targetPrice);
  const key = `${colIdx},${targetPrice.toFixed(4)}`;
  if(placedBets.has(key)) return;
  if(colTime <= gameTime) return;

  // Convert targetPrice to 8 decimal format and scale it to U256 (low, high)
  const priceU256 = Math.floor(targetPrice * 100000000).toString();
  // colTime represents the target timestamp relative to gameTime
  const timestampU64 = Math.floor(Date.now() / 1000 + (colTime - gameTime)).toString();

  // Call "tap" on Starknet testnet seamlessly using Cartridge paymaster
  try {
    userWallet.execute([{
      contractAddress: CONTRACT_ADDRESS,
      entrypoint: "tap",
      // u256 price(low, high), u64 timestamp, u256 ref_price(low, high)
      calldata: [priceU256, "0", timestampU64, priceU256, "0"]
    }]).then(tx => {
      console.log("Cartridge Tx Sent successfully!", tx);
      showToast("Tx submitted to Starknet!", "info");
    }).catch(err => {
      console.error("Cartridge Tx execution failed:", err);
    });
  } catch (err) {
    console.error("Failed to build Cartridge Tx:", err);
  }

  const payout = parseFloat((stake * mult).toFixed(2));
  placedBets.set(key, {colIdx, mult, payout, colTime, isUp, targetPrice, resolved: false});

  cell.dataset.placed = '1';
  cell.style.background = 'rgba(245,197,24,0.12)';
  cell.style.outline = '1.5px solid rgba(245,197,24,0.6)';
  cell.style.outlineOffset = '-1px';
  cell.querySelector('div').style.color = 'rgba(245,197,24,0.9)';

  showToast(`Placed $${stake} @ ${mult}x — wins $${payout}`, 'info');
}

// ═══════════════════════════════════════════════
//  PRICE TICK
// ═══════════════════════════════════════════════
// ═══════════════════════════════════════════════
//  CAMERA & DYNAMIC ROWS
// ═══════════════════════════════════════════════
function updateCamera() {
  if (rowPrices.length === 0) return;
  const currentHeadY = priceToY(price);
  
  const topBound = vpH * 0.3;
  const bottomBound = vpH * 0.7;
  
  if (currentHeadY < topBound) {
    targetGridOffsetY += (topBound - currentHeadY) * 0.05;
  } else if (currentHeadY > bottomBound) {
    targetGridOffsetY -= (currentHeadY - bottomBound) * 0.05;
  }
  
  gridOffsetY += (targetGridOffsetY - gridOffsetY) * 0.15;
  manageDynamicRows();
}

function manageDynamicRows() {
  let changed = false;

  // Add rows top
  while (gridOffsetY > -CELL_H * 2) {
    const newPrice = rowPrices[0] + TICK_SIZE;
    rowPrices.unshift(newPrice);
    gridOffsetY -= CELL_H;
    targetGridOffsetY -= CELL_H; 
    numRows++;
    
    renderedCols.forEach((colEl, idx) => {
      colEl.style.height = `${numRows * CELL_H}px`;
      const colTime = colIndexToTime(idx);
      const isPast = colTime < gameTime;
      const cell = createCell(0, idx, colTime, isPast);
      colEl.insertBefore(cell, colEl.firstChild);
      updateCellIndices(colEl);
    });
    
    const body = document.getElementById('pa-body');
    const lbl = createAxisLabel(newPrice);
    body.insertBefore(lbl, body.firstChild);
    changed = true;
  }

  // Add rows bottom
  while (numRows * CELL_H + gridOffsetY < vpH + CELL_H * 2) {
    const newPrice = rowPrices[rowPrices.length - 1] - TICK_SIZE;
    rowPrices.push(newPrice);
    numRows++;
    
    renderedCols.forEach((colEl, idx) => {
      colEl.style.height = `${numRows * CELL_H}px`;
      const colTime = colIndexToTime(idx);
      const isPast = colTime < gameTime;
      const cell = createCell(numRows - 1, idx, colTime, isPast);
      colEl.appendChild(cell);
    });
    
    const body = document.getElementById('pa-body');
    const lbl = createAxisLabel(newPrice);
    body.appendChild(lbl);
    changed = true;
  }
  
  if (changed || Math.abs(targetGridOffsetY - gridOffsetY) > 0.1) {
    cellLayer.style.top = `${gridOffsetY}px`;
    updatePriceAxisLabels();
  }
}

function updateCellIndices(colEl) {
  const cells = colEl.children;
  for(let i=0; i<cells.length; i++){
    cells[i].dataset.row = i;
  }
}

function tickPrice(){
  const prevPrice = price;
  
  if(lastWsPrice !== null && !useSimulatedPrice){
    price = lastWsPrice;
  }else{
    const pd = PAIRS[activePair];
    const drift = (Math.random() - 0.49) * 0.00028;
    price = parseFloat((price + price * drift).toFixed(4));
  }
  
  gameTime += TICK_MS / 1000;
  tickCount++;

  // Add interpolated points for smoother price line
  if(lastWsPrice !== null && !useSimulatedPrice && Math.abs(price - prevPrice) > 0.01){
    const steps = 2;
    const timeStep = (TICK_MS / 1000) / steps;
    for(let i = 1; i <= steps; i++){
      const interpPrice = prevPrice + (price - prevPrice) * (i / steps);
      priceHistory.push({t: gameTime - timeStep * (steps - i), p: interpPrice});
    }
  }else{
    priceHistory.push({t: gameTime, p: price});
  }
  
  // keep ~90s of history
  while(priceHistory.length > 0 && gameTime - priceHistory[0].t > 90) priceHistory.shift();

  // resolve bets whose column time has just passed
  placedBets.forEach((bet, key) => {
    if(!bet.resolved && gameTime >= bet.colTime){
      resolveBet(bet, key);
    }
  });

  updateTopBar();
}

// ═══════════════════════════════════════════════
//  RESOLVE BET
// ═══════════════════════════════════════════════
function resolveBet(bet, key){
  bet.resolved = true;
  // Use a minute tick size tolerance (e.g., within 1 TICK_SIZE which is 0.05)
  const hit = Math.abs(price - bet.targetPrice) <= TICK_SIZE;

  // find the cell DOM element
  const colEl = renderedCols.get(bet.colIdx);
  let cell = null;
  if (colEl) {
      const cr = Math.round((rowPrices[0] - bet.targetPrice) / TICK_SIZE);
      if (cr >= 0 && cr < numRows) {
          cell = colEl.children[cr];
      }
  }

  if(hit){
    score += 10;
    saveScore();
    if(cell){
      cell.style.background = 'rgba(0,168,84,0.5)';
      cell.style.outline = '1.5px solid rgba(0,168,84,0.9)';
    }
    showToast(`WIN! +10 PTS ($${bet.payout})`, 'win');
  } else {
    if(cell){
      cell.style.background = 'rgba(234,57,67,0.45)';
      cell.style.outline = '1.5px solid rgba(234,57,67,0.7)';
    }
    showToast(`Miss — price didn't reach that level`, 'lose');
  }
}

// ═══════════════════════════════════════════════
//  DRAW LOOP
// ═══════════════════════════════════════════════
function drawLoop(now){
  ensureColumns(now);
  updateCamera();
  drawMain();
  drawTimebar();
  animFrame = requestAnimationFrame(drawLoop);
}

function drawMain(){
  const c = mainCtx;
  c.clearRect(0, 0, vpW, vpH);

  // ── FADE OVERLAY for past (left of NOW line) ──
  if(!fadeGradient || fadeGradient.nowX !== nowX){
    fadeGradient = c.createLinearGradient(0, 0, nowX, 0);
    fadeGradient.nowX = nowX;
    fadeGradient.addColorStop(0,   'rgba(249,246,233,0.95)');
    fadeGradient.addColorStop(0.6, 'rgba(249,246,233,0.6)');
    fadeGradient.addColorStop(1,   'rgba(249,246,233,0.0)');
  }
  c.fillStyle = fadeGradient;
  c.fillRect(0, 0, nowX, vpH);

  // ── NOW LINE ──
  c.beginPath();
  c.moveTo(nowX, 0); c.lineTo(nowX, vpH);
  c.strokeStyle = 'rgba(212,165,0,0.8)';
  c.lineWidth = 1;
  c.setLineDash([4,4]);
  c.stroke();
  c.setLineDash([]);

  // NOW label
  c.fillStyle = 'rgba(212,165,0,0.95)';
  c.font = '700 9px JetBrains Mono';
  c.textAlign = 'center';
  c.fillText('NOW', nowX, 11);

  // ── PRICE LINE ──
  if(priceHistory.length > 1){
    // glow pass
    c.beginPath();
    let first = true;
    priceHistory.forEach(pt => {
      const x = nowX + (pt.t - gameTime) / COL_SEC * CELL_W;
      const y = priceToY(pt.p);
      if(first){ c.moveTo(x, y); first = false; } else c.lineTo(x, y);
    });
    c.strokeStyle = 'rgba(0,168,84,0.2)';
    c.lineWidth = 7;
    c.lineJoin = 'round';
    c.lineCap  = 'round';
    c.stroke();

    // core line
    c.beginPath();
    first = true;
    priceHistory.forEach(pt => {
      const x = nowX + (pt.t - gameTime) / COL_SEC * CELL_W;
      const y = priceToY(pt.p);
      if(first){ c.moveTo(x, y); first = false; } else c.lineTo(x, y);
    });

    // gradient along line: dim in past, bright at now
    const lineStartX = nowX - FADE_COLS * CELL_W;
    if(!lineGradient || lineGradient.startX !== lineStartX || lineGradient.nowX !== nowX){
      lineGradient = c.createLinearGradient(lineStartX, 0, nowX, 0);
      lineGradient.startX = lineStartX;
      lineGradient.nowX = nowX;
      lineGradient.addColorStop(0,   'rgba(0,168,84,0.1)');
      lineGradient.addColorStop(0.7, 'rgba(0,168,84,0.5)');
      lineGradient.addColorStop(1,   'rgba(0,168,84,1)');
    }
    c.strokeStyle = lineGradient;
    c.lineWidth = 1.5;
    c.stroke();
  }

  // ── PRICE DOT (head) ──
  const headY = priceToY(price);
  // outer glow
  c.beginPath();
  c.arc(nowX, headY, 9, 0, Math.PI*2);
  c.fillStyle = 'rgba(0,168,84,0.15)';
  c.fill();
  // dot
  c.beginPath();
  c.arc(nowX, headY, 4.5, 0, Math.PI*2);
  c.fillStyle = '#00a854';
  c.fill();
  // inner
  c.beginPath();
  c.arc(nowX, headY, 1.8, 0, Math.PI*2);
  c.fillStyle = '#fff';
  c.fill();

  // ── CURRENT PRICE LABEL ──
  const priceLabel = fmtPriceFull(price);
  const lw = c.measureText(priceLabel).width + 10;
  c.fillStyle = '#00a854';
  roundRect(c, nowX + 8, headY - 9, lw, 18, 3);
  c.fill();
  c.fillStyle = '#fff';
  c.font = '700 9px JetBrains Mono';
  c.textAlign = 'left';
  c.fillText(priceLabel, nowX + 13, headY + 3.5);

  // ── HORIZONTAL PRICE GRIDLINES ──
  c.textAlign = 'right';
  rowPrices.forEach((rp, i) => {
    const mainY = i * CELL_H + CELL_H / 2 + gridOffsetY;
    
    // Draw 10 virtual minor subdivisions (ticks) to represent smaller cents
    if (i < rowPrices.length - 1) {
      for (let m = 1; m < 10; m++) {
        const minorY = mainY + m * (CELL_H / 10);
        c.beginPath();
        c.moveTo(vpW - 10, minorY); // Small tick on the right edge
        c.lineTo(vpW, minorY);
        // Also a faint line across
        c.moveTo(0, minorY);
        c.lineTo(vpW, minorY);
        c.strokeStyle = 'rgba(0,0,0,0.025)';
        c.lineWidth = 1;
        c.stroke();
      }
    }

    c.beginPath();
    c.moveTo(0, mainY); c.lineTo(vpW, mainY);
    c.strokeStyle = 'rgba(0,0,0,0.06)';
    c.lineWidth = 1;
    c.stroke();
  });
}

function drawTimebar(){
  const c = timebarCtx;
  const w = timebarCanvas.width, h = timebarCanvas.height;
  c.clearRect(0, 0, w, h);

  // background
  c.fillStyle = 'rgba(255,255,255,1)';
  c.fillRect(0, 0, w, h);

  // border bottom
  c.fillStyle = 'rgba(0,0,0,0.08)';
  c.fillRect(0, h-1, w, 1);

  // column time labels
  c.font = '9px JetBrains Mono';
  c.textAlign = 'center';

  renderedCols.forEach((colEl, idx) => {
    const t   = colIndexToTime(idx);
    const x   = nowX + (t - gameTime) / COL_SEC * CELL_W;
    if(x < 0 || x > w + CELL_W) return;

    const secsDiff = Math.round(t - gameTime);
    const label = secsDiff === 0 ? 'NOW'
      : secsDiff > 0 ? '+' + secsDiff + 's'
      : secsDiff + 's';
    const isPast = t < gameTime;

    // tick mark
    c.fillStyle = isPast ? 'rgba(0,0,0,0.06)' : 'rgba(0,0,0,0.15)';
    c.fillRect(x - 0.5, h - 6, 1, 6);

    c.fillStyle = secsDiff === 0 ? 'rgba(212,165,0,0.95)'
      : isPast ? 'rgba(0,0,0,0.2)'
      : 'rgba(0,0,0,0.45)';
    c.fillText(label, x, h - 10);
  });

  // NOW line in timebar
  c.fillStyle = 'rgba(212,165,0,0.6)';
  c.fillRect(nowX - 0.5, 0, 1, h);
}

function roundRect(ctx, x, y, w, h, r){
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.lineTo(x+w-r, y); ctx.quadraticCurveTo(x+w, y, x+w, y+r);
  ctx.lineTo(x+w, y+h-r); ctx.quadraticCurveTo(x+w, y+h, x+w-r, y+h);
  ctx.lineTo(x+r, y+h); ctx.quadraticCurveTo(x, y+h, x, y+h-r);
  ctx.lineTo(x, y+r); ctx.quadraticCurveTo(x, y, x+r, y);
  ctx.closePath();
}

// ═══════════════════════════════════════════════
//  UI HELPERS
// ═══════════════════════════════════════════════
function renderLives(){
  const w = document.getElementById('tb-lives');
  if (!w) return;
  w.innerHTML = '';
  for(let i = 0; i < 3; i++){
    const d = document.createElement('div');
    d.className = 'tb-life' + (i >= lives ? ' lost' : '');
    w.appendChild(d);
  }
}

function updateTopBar(){
  const chg = ((price - priceStart) / priceStart * 100).toFixed(2);
  document.getElementById('tb-price').textContent = fmtPriceFull(price);
  const el = document.getElementById('tb-chg');
  el.textContent = (parseFloat(chg) >= 0 ? '+' : '') + chg + '%';
  el.style.color = parseFloat(chg) >= 0 ? 'var(--green)' : 'var(--red)';
}

function fmtPrice(v){
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPriceFull(v){
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

let toastTimer;
function showToast(msg, type){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
}

// ═══════════════════════════════════════════════
//  CONTROLS
// ═══════════════════════════════════════════════
document.querySelectorAll('.s-btn').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.s-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    stake = parseFloat(b.dataset.v);
  });
});

document.querySelectorAll('.pair-chip').forEach(c => {
  c.addEventListener('click', () => {
    document.querySelectorAll('.pair-chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active');
    init(c.dataset.pair);
  });
});

// ═══════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════
async function fetchCurrentBtcPrice(){
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
    if(!res.ok) throw new Error('Fetch failed');
    const data = await res.json();
    const live = parseFloat(data?.price);
    if(Number.isFinite(live) && live > 0) return live;
  } catch (err){
    console.warn('BTC price fetch failed:', err);
  }
  return 65000; // fallback to default BTC price
}

function truncateAddress(addr) {
  if (!addr || typeof addr !== 'string') return 'Connected';
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

async function handleWalletClick() {
  if (window.innerWidth <= 768 && !userWallet) {
    showToast("Use Desktop/Tablet to connect wallet!", "info");
    return;
  }
  const btn = document.getElementById("btn-connect");
  if (userWallet) {
    // Attempt to disconnect if the SDK supports it, otherwise clear state
    try {
      if (starkZapSdk && typeof starkZapSdk.disconnect === 'function') {
        await starkZapSdk.disconnect();
      }
    } catch (e) {
      console.warn("Disconnect error", e);
    }
    userWallet = null;
    loadScore();
    if (btn) {
      btn.textContent = "Connect Wallet";
      btn.style.background = "rgba(212,165,0,0.1)";
      btn.style.color = "var(--yellow)";
      btn.style.borderColor = "rgba(212,165,0,0.4)";
    }
    showToast("Wallet disconnected", "info");
    return;
  }

  // Connect flow
  if (!starkZapSdk) {
    starkZapSdk = new StarkZap({ network: "sepolia" });
  }

  const policies = [
    {
      target: CONTRACT_ADDRESS,
      method: "tap",
    },
  ];

  try {
    const onboard = await starkZapSdk.onboard({
      strategy: OnboardStrategy.Cartridge,
      cartridge: { policies },
      deploy: "if_needed",
    });
    userWallet = onboard.wallet;
    
    // Attempt to extract the address
    const addr = userWallet?.account?.address || userWallet?.address || userWallet?.selectedAddress;
    loadScore();
    
    // Update button UI
    if (btn) {
      btn.innerHTML = `<span>${truncateAddress(addr)}</span>`;
      btn.style.background = "rgba(0,168,84,0.2)";
      btn.style.color = "var(--green)";
      btn.style.borderColor = "rgba(0,168,84,0.5)";
    }
    showToast("Connected via Cartridge!", "win");
  } catch (err) {
    console.error("Cartridge connection failed:", err);
    showToast("Wallet connection failed", "lose");
  }
}

window.addEventListener('load', async () => {
  const btn = document.getElementById("btn-connect");
  if(btn) btn.addEventListener("click", handleWalletClick);

  const livePrice = await fetchCurrentBtcPrice();
  init('BTC/USDT', livePrice);
});
