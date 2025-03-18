const express = require('express');
const EventEmitter = require('events');
const fetch = require('node-fetch');
const app = express();

let lastUpdate = {
    symbol: null,
    moves: 0,
    timestamp: null
};

app.use(express.json());

class SymbolScanner extends EventEmitter {
    constructor() {
        super();
        this.priceHistory = new Map();
        this.volatilityScores = new Map();
        this.volumes = new Map();
        this.lastMinuteCheck = null;
        this.isRunning = false;
        this.intervalId = null;
        this.hasErrorThisMinute = false;
    }

    reset() {
        this.priceHistory.clear();
        this.volatilityScores.clear();
        this.volumes.clear();
        this.hasErrorThisMinute = false;
    }

    async fetchTickers() {
        try {
            const response = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
            const data = await response.json();

            const currentTime = new Date();
            
            data.result.list.forEach(ticker => {
                if (ticker.symbol.endsWith('USDT')) {
                    const price = parseFloat(ticker.lastPrice);
                    const volume = parseFloat(ticker.turnover24h);
                    
                    if (!this.priceHistory.has(ticker.symbol)) {
                        this.priceHistory.set(ticker.symbol, []);
                    }
                    
                    this.priceHistory.get(ticker.symbol).push({
                        price,
                        timestamp: currentTime
                    });

                    this.volumes.set(ticker.symbol, volume);
                }
            });

        } catch (error) {
            this.hasErrorThisMinute = true;
            if (error.name === 'AbortError' || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
                console.error('Connection timeout or network error:', error.message);
            } else {
                console.error('Error scanning tickers:', error.message);
            }
        }
    }

    calculateVolatility() {
        this.volatilityScores.clear();
        const now = new Date();
        const oneMinuteAgo = new Date(now - 60000);

        for (const [symbol, prices] of this.priceHistory.entries()) {
            const relevantPrices = prices.filter(p => p.timestamp >= oneMinuteAgo);
            
            if (relevantPrices.length < 2) continue;

            let totalMovement = 0;
            for (let i = 1; i < relevantPrices.length; i++) {
                const movement = Math.abs(
                    relevantPrices[i].price - relevantPrices[i-1].price
                );
                totalMovement += movement;
            }

            const averagePrice = relevantPrices.reduce((sum, p) => sum + p.price, 0) / relevantPrices.length;
            const volatilityScore = (totalMovement / averagePrice) * 100;
            
            this.volatilityScores.set(symbol, volatilityScore);
        }
    }

    async findBestPerformer() {
        const minVolume = 10000000; // $10M minimum 24h volume
        const topPairs = Array.from(this.volatilityScores.entries())
            .filter(([symbol]) => this.volumes.get(symbol) >= minVolume)
            .sort(([symbolA, scoreA], [symbolB, scoreB]) => {
                const scoreDiff = scoreB - scoreA;
                if (Math.abs(scoreDiff) > 0.0001) {
                    return scoreDiff;
                }
                return this.volumes.get(symbolB) - this.volumes.get(symbolA);
            });

        if (!topPairs.length) {
            return {
                symbol: null,
                moves: 0,
                hasError: this.hasErrorThisMinute
            };
        }

        const [symbol, score] = topPairs[0];
        return {
            symbol,
            moves: Math.round(score * 100), // Convert volatility score to "moves" for compatibility
            hasError: this.hasErrorThisMinute
        };
    }

    async processMinute() {
        const now = new Date();
        const seconds = now.getSeconds();
        
        if (seconds === 0) {
            this.reset();
            console.log('[Scanner] Starting new minute');
        }
        
        if (seconds < 59) {
            await this.fetchTickers();
            this.calculateVolatility();
        }
        
        if (seconds === 59) {
            const result = await this.findBestPerformer();
            if (!result.hasError && result.symbol) {
                console.log(`\n[Scanner] ${new Date().toLocaleTimeString()} - Best performer: ${result.symbol} (${result.moves} moves)\n`);
                console.log('[Scanner] Emitting bestPerformerFound event with:', result);
                this.emit('bestPerformerFound', result);
                console.log('[Scanner] Event emitted');
            }
        }
    }

    start() {
        if (!this.isRunning) {
            this.isRunning = true;
            this.intervalId = setInterval(() => this.processMinute(), 1000);
            console.log('[Scanner] Symbol scanning started');
        }
    }

    stop() {
        if (this.isRunning && this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            this.isRunning = false;
            console.log('[Scanner] Symbol scanning stopped');
        }
    }

    cleanupOldData() {
        const twoMinutesAgo = new Date(Date.now() - 120000);
        for (const [symbol, prices] of this.priceHistory.entries()) {
            this.priceHistory.set(
                symbol,
                prices.filter(p => p.timestamp >= twoMinutesAgo)
            );
        }
    }
}

const scanner = new SymbolScanner();
scanner.on('bestPerformerFound', (data) => {
    console.log('[Scanner] Internal event listener caught bestPerformerFound:', data.symbol);
    lastUpdate = {
        symbol: data.symbol,
        moves: data.moves,
        timestamp: Date.now()
    };
});
scanner.start();

app.get('/api/updates', (req, res) => {
    const lastUpdateTime = parseInt(req.query.lastUpdate) || 0;
    
    if (lastUpdate.timestamp && lastUpdate.timestamp > lastUpdateTime) {
        res.json(lastUpdate);
    } else {
        res.status(304).send();
    }
});

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Market Scanner</title>
      <style>
        body {
          margin: 0;
          height: 100vh;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          font-family: Arial, sans-serif;
          background-color: #f0f0f0;
          gap: 2rem;
        }
        #time {
          font-size: 4rem;
          font-weight: bold;
          color: #333;
        }
        #symbol-container {
          text-align: center;
        }
        #symbol-label {
          font-size: 1.5rem;
          color: #666;
          margin-bottom: 0.5rem;
        }
        #best-symbol {
          font-size: 2.5rem;
          font-weight: bold;
          color: #2196F3;
        }
        #moves {
          font-size: 1.2rem;
          color: #666;
          margin-top: 0.5rem;
        }
      </style>
    </head>
    <body>
      <div id="time"></div>
      <div id="symbol-container">
        <div id="symbol-label">Best Performing Symbol</div>
        <div id="best-symbol">-</div>
        <div id="moves">-</div>
      </div>
      <script>
        function updateTime() {
          const now = new Date();
          const time = now.toLocaleTimeString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
          });
          document.getElementById('time').textContent = time;
        }
        updateTime();
        setInterval(updateTime, 1000);

        // Long polling for updates
        let lastUpdateTime = 0;
        
        function pollForUpdates() {
            fetch('/api/updates?lastUpdate=' + lastUpdateTime)
                .then(response => {
                    if (response.status === 304) {
                        return null;
                    }
                    return response.json();
                })
                .then(data => {
                    if (data) {
                        document.getElementById('best-symbol').textContent = data.symbol;
                        document.getElementById('moves').textContent = `${data.moves} moves`;
                        lastUpdateTime = data.timestamp;
                    }
                })
                .catch(error => console.error('Polling error:', error))
                .finally(() => {
                    setTimeout(pollForUpdates, 1000);
                });
        }
        
        pollForUpdates();
      </script>
    </body>
    </html>
  `);
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
