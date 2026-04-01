# EverTapp

EverTapp is a real-time, continuous market prediction game integrated smoothly with **Starkzap** and the **Cartridge Controller** to execute frictionless on-chain interactions on the Starknet Sepolia testnet.

## Getting Started

1. **Install dependencies**: `npm install`
2. **Start the local server**: `npm run dev`
3. Navigate to the local URL provided by Vite (e.g. `http://localhost:5173`).

## Playing the Game

### 1. Connecting Your Wallet
Before placing any predictions, you must connect your wallet.
1. Click the **"Connect Wallet"** button in the top right corner.
2. The **Cartridge Controller** handles authentication by letting you sign in easily (via social accounts, passkeys, etc.) without managing seed phrases. 
3. *Note*: The application uses Cartridge Paymaster policies. Connecting establishes a session allowing you to seamlessly "tap" and play without confirming every transaction in a wallet popup!

### 2. How Prices Are Updated
The game tracks live market movements with highly granular precision:
- **Real-Time Data**: Live prices stream directly from the Binance spot WebSocket (`@aggTrade`), ensuring split-second updates.
- **Micro-Movements**: Every single physical row in the grid represents exactly **$1.00** of price movement. 
- **Dynamic Camera**: As the live price moves up and down, the grid dynamically centers and tracks the asset smoothly to keep the action on-screen.

### 3. How to "Tap" (Place a Prediction)
The grid's horizontal axis represents **Time** (future seconds incrementally fading in from the right), while the vertical axis represents the **Price Target**.
1. Pick a future grid cell (e.g., $5 above the current price, 15 seconds in the future) and simply **Tap (Click) it**.
2. **Under-the-hood**: When you click the cell, the app dispatches an on-chain transaction instantly. 
3. The game passes three exact values to the Starknet Sepolia smart contract function `tap(price, timestamp, ref_price)`:
   - Your targeted cell `price` scaled to 8 decimals.
   - The cell's target Unix `timestamp` corresponding to that column on the grid.
   - A `ref_price` validator parameter.

### 4. How Wins and Losses are Registered
Once your prediction is registered, the cell will glow yellow to signify it's an active bet. The result of your bet is determined when the dynamic "NOW" line catches up to the time-column of your selected cell.

#### Example Scenario
Imagine the current Bitcoin (BTC) price is **$65,000**. You tap a grid cell that represents the target price **$65,005** exactly **15 seconds** in the future. 

- **Winning (+10 Points)**: 
  As 15 seconds real-time tick by, the vertical "NOW" line reaches your cell's column. At that exact moment, the live streaming BTC price is **$65,005.40** (striking within the $1 boundary of $65,005). 
  - **Result:** You **Win**! 
  - The cell flashes **green** to indicate the hit.
  - A toast confirms the payout and your points increase.

- **Losing / Miss (0 Points)**: 
  As 15 seconds pass, the vertical "NOW" line reaches your cell's column. However, the price only made it to **$65,002.10** (or completely overshot to $65,010) and did not land inside the exact $65,005 zone.
  - **Result:** You **Miss**.
  - The cell fades **red**.
  - A toast notifies you that the price didn't reach your target level.
