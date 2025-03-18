import express from 'express';
import cors from 'cors';
import EventEmitter from 'events';
import fetch from 'node-fetch';

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
            moves: Math.round(score * 100),
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
                const response = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
                const data = await response.json();
                const ticker = data.result.list.find(t => t.symbol === result.symbol);
                const fundingRate = (parseFloat(ticker.fundingRate) * 100).toFixed(4);
                const turnover = (parseFloat(ticker.turnover24h) / 1000000).toFixed(2);
                
                this.emit('bestPerformerFound', {
                    symbol: result.symbol,
                    moves: result.moves,
                    turnover: turnover,
                    fundingRate: fundingRate
                });
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

const app = express();
app.use(cors());

// Store scanner results
let currentSymbol = null;
let symbolHistory = [];

// Initialize scanner
const scanner = new SymbolScanner();

// Handle scanner events
scanner.on('bestPerformerFound', (data) => {
    if (data.symbol && !data.hasError) {
        const symbolData = {
            symbol: data.symbol,
            moves: data.moves,
            turnover: data.turnover,
            fundingRate: data.fundingRate,
            timestamp: new Date()
        };
        
        currentSymbol = symbolData;
        symbolHistory = [symbolData, ...symbolHistory];
        
        // Keep only last 24 hours of history
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        symbolHistory = symbolHistory.filter(item => item.timestamp > twentyFourHoursAgo);
    }
});

// API endpoints
// API endpoint to get current symbol and history
app.get('/api/symbols', (req, res) => {
    res.json({
        current: currentSymbol,
        history: symbolHistory
    });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    scanner.start();
});

// Serve static HTML
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Bybit Symbol Scanner</title>
            <style>
                :root {
                    color-scheme: light dark;
                }
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                    margin: 0;
                    padding: 0;
                    background-color: #f5f5f5;
                    color: #333;
                }
                @media (prefers-color-scheme: dark) {
                    body {
                        background-color: #1a1a1a;
                        color: #e5e5e5;
                    }
                }
                .min-h-screen {
                    min-height: 100vh;
                }
                .p-8 {
                    padding: 2rem;
                }
                .max-w-4xl {
                    max-width: 56rem;
                    margin: 0 auto;
                }
                .bg-white {
                    background-color: white;
                    border-radius: 0.5rem;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
                    padding: 1.5rem;
                    margin-bottom: 1.5rem;
                }
                @media (prefers-color-scheme: dark) {
                    .bg-white {
                        background-color: #2d2d2d;
                    }
                }
                .text-center {
                    text-align: center;
                }
                .text-sm {
                    font-size: 0.875rem;
                }
                .text-gray-500 {
                    color: #6b7280;
                }
                @media (prefers-color-scheme: dark) {
                    .text-gray-500 {
                        color: #9ca3af;
                    }
                }
                .space-y-4 > * + * {
                    margin-top: 1rem;
                }
                .bg-gray-50 {
                    background-color: #f9fafb;
                    border-radius: 0.5rem;
                    padding: 1.5rem;
                }
                @media (prefers-color-scheme: dark) {
                    .bg-gray-50 {
                        background-color: #374151;
                    }
                }
                .flex {
                    display: flex;
                }
                .items-center {
                    align-items: center;
                }
                .justify-between {
                    justify-content: space-between;
                }
                .space-x-4 > * + * {
                    margin-left: 1rem;
                }
                .mb-4 {
                    margin-bottom: 1rem;
                }
                .text-indigo-600 {
                    color: #4f46e5;
                    text-decoration: none;
                }
                .text-indigo-600:hover {
                    color: #4338ca;
                }
                @media (prefers-color-scheme: dark) {
                    .text-indigo-600 {
                        color: #818cf8;
                    }
                    .text-indigo-600:hover {
                        color: #6366f1;
                    }
                }
                .text-xs {
                    font-size: 0.75rem;
                }
                .bg-red-100 {
                    background-color: #fee2e2;
                    border-radius: 0.5rem;
                    padding: 1rem;
                }
                .text-red-700 {
                    color: #b91c1c;
                }
                @media (prefers-color-scheme: dark) {
                    .bg-red-100 {
                        background-color: #7f1d1d;
                    }
                    .text-red-700 {
                        color: #fca5a5;
                    }
                }
            </style>
        </head>
        <body>
            <div class="min-h-screen p-8">
                <main class="max-w-4xl">
                    <div class="bg-white">
                        <div class="text-center mb-4 text-sm text-gray-500">
                            Scanner active - ${new Date().toLocaleTimeString().replace(/AM|PM/g, '')}
                        </div>

                        <div class="space-y-4" id="symbolContainer">
                            <div id="currentSymbol">
                                Loading current symbol...
                            </div>
                            
                            <div id="symbolHistory" class="space-y-4">
                            </div>
                        </div>
                    </div>
                </main>
            </div>

            <script>
                function formatSymbolCard(data, isCurrent = false) {
                    return `
                        <div class="bg-gray-50 ${isCurrent ? '' : 'opacity-80'}">
                            <div class="flex items-center justify-between space-x-4 mb-4">
                                <div>${data.symbol}</div>
                                <div>${data.moves}</div>
                                <div>$${data.turnover}M</div>
                                <div>${data.fundingRate}%</div>
                                <a
                                    href="https://www.bybit.com/trade/usdt/${data.symbol}"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    class="text-indigo-600"
                                >
                                    trade
                                </a>
                                ${data.timestamp ? `
                                    <div class="text-xs text-gray-500">
                                        Found at: ${new Date(data.timestamp).toLocaleTimeString('en-US', { hour12: false })}
                                    </div>
                                ` : ''}
                            </div>
                        </div>
                    `;
                }

                function updateData() {
                    fetch('/api/symbols')
                        .then(response => response.json())
                        .then(data => {
                            const currentSymbolEl = document.getElementById('currentSymbol');
                            const historyEl = document.getElementById('symbolHistory');

                            if (data.current) {
                                currentSymbolEl.innerHTML = formatSymbolCard(data.current, true);
                            } else {
                                currentSymbolEl.innerHTML = '<div class="bg-gray-50">Waiting for best performing symbol...</div>';
                            }

                            if (data.history && data.history.length > 0) {
                                historyEl.innerHTML = data.history
                                    .map(item => formatSymbolCard(item))
                                    .join('');
                            }
                        })
                        .catch(error => {
                            console.error('Error fetching data:', error);
                            document.getElementById('symbolContainer').innerHTML = `
                                <div class="bg-red-100 text-red-700">
                                    Error connecting to scanner: ${error.message}
                                </div>
                            `;
                        });
                }

                // Update data every second
                updateData();
                setInterval(updateData, 1000);
            </script>
        </body>
        </html>
    `);
});

// Start scanner
scanner.start();

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Symbol scanner server running on port ${PORT}`);
});