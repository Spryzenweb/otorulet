const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = createServer(app);

// CORS configuration
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:5173').split(',');

const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        allowedHeaders: ["my-custom-header"],
        credentials: true
    }
});

app.use(cors({
    origin: allowedOrigins,
    credentials: true
}));
app.use(express.json());

// SADECE MEMORY'DE OYUN DURUMU - DB YOK
const gameState = {
    currentRound: 0,
    betsOpen: false,
    countdown: 0,
    winningNumber: null,
    phase: 'waiting', // waiting, betting, spinning, calculating
    
    // Kullanıcı sessionları (sadece WebSocket için)
    userSessions: new Map(), // userId -> { socketId, lastSeen, username }
    
    // Aktif bahisler (bu round için)
    currentBets: new Map(), // userId -> [bets]
    
    // Son kazananlar (frontend için)
    lastWinners: []
};

// Game configuration
const BETTING_DURATION = parseInt(process.env.BETTING_DURATION) || 30;
const ROUND_DELAY = parseInt(process.env.ROUND_DELAY) || 10;
const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY || 'gizli-anahtar';

class MemoryRouletteGame {
    constructor() {
        this.countdownTimer = null;
        this.isRunning = false;
    }

    start() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        console.log('🎮 Memory-based Rulet sistemi başlatılıyor (DB yok)...');
        
        // Start first round immediately
        this.startNewRound();
    }

    startNewRound() {
        if (!this.isRunning) return;

        gameState.currentRound++;
        gameState.phase = 'betting';
        gameState.betsOpen = true;
        gameState.countdown = BETTING_DURATION;
        gameState.winningNumber = null;
        gameState.currentBets.clear();
        
        console.log(`🎯 Yeni tur başladı: ${gameState.currentRound} (Memory mode)`);
        
        // Broadcast new round
        io.emit('new_round', {
            roundNumber: gameState.currentRound,
            countdown: gameState.countdown,
            phase: gameState.phase,
            betsOpen: gameState.betsOpen
        });

        // Start countdown
        this.startCountdown();
    }

    startCountdown() {
        if (this.countdownTimer) {
            clearInterval(this.countdownTimer);
        }

        this.countdownTimer = setInterval(() => {
            gameState.countdown--;
            
            // Broadcast countdown
            io.emit('countdown_update', { 
                countdown: gameState.countdown,
                phase: gameState.phase 
            });

            if (gameState.countdown <= 0) {
                this.closeBets();
            }
        }, 1000);
    }

    closeBets() {
        if (this.countdownTimer) {
            clearInterval(this.countdownTimer);
            this.countdownTimer = null;
        }

        gameState.betsOpen = false;
        gameState.phase = 'closed';
        
        console.log('🔒 Bahisler kapandı');
        
        io.emit('bets_closed', { phase: gameState.phase });

        // Wait a moment then spin
        setTimeout(() => {
            this.spinWheel();
        }, 2000);
    }

    spinWheel(forcedNumber = null) {
        gameState.phase = 'spinning';
        
        // Generate winning number
        const winningNumber = forcedNumber !== null ? forcedNumber : Math.floor(Math.random() * 37);
        gameState.winningNumber = winningNumber;

        console.log(`🎰 Çark sonucu: ${winningNumber} (Memory mode)`);
        
        // Broadcast spin result
        io.emit('spin_result', { 
            number: winningNumber,
            phase: gameState.phase
        });

        // Wait for animation then process results
        setTimeout(() => {
            this.processRoundResults(winningNumber);
        }, 8000);
    }

    processRoundResults(winningNumber) {
        gameState.phase = 'calculating';
        
        let totalBets = 0;
        let totalPayouts = 0;
        const winners = [];

        // Her kullanıcının bahislerini işle
        for (const [userId, userBets] of gameState.currentBets) {
            let userTotalBet = 0;
            let userTotalWin = 0;

            for (const bet of userBets) {
                userTotalBet += bet.amount;
                totalBets += bet.amount;

                if (this.isWinningBet(bet, winningNumber)) {
                    const winAmount = bet.amount * bet.multiplier;
                    userTotalWin += winAmount;
                    totalPayouts += winAmount;
                }
            }

            if (userTotalWin > 0) {
                const userSession = gameState.userSessions.get(userId);
                winners.push({
                    username: userSession?.username || `User${userId}`,
                    amount: userTotalWin,
                    userId: userId
                });

                // Kullanıcıya kazanç bildir (WebSocket üzerinden)
                const socket = io.sockets.sockets.get(userSession?.socketId);
                if (socket) {
                    socket.emit('round_win', {
                        amount: userTotalWin,
                        roundNumber: gameState.currentRound,
                        winningNumber: winningNumber,
                        message: `Tebrikler! ${userTotalWin}₺ kazandınız!`
                    });
                }
            }

            console.log(`👤 ${userId}: Bahis: ${userTotalBet}₺, Kazanç: ${userTotalWin}₺`);
        }

        // Save winners for display
        gameState.lastWinners = winners.slice(0, 10); // Son 10 kazanan

        console.log(`📊 Tur ${gameState.currentRound} tamamlandı. Bahis: ${totalBets}₺, Ödeme: ${totalPayouts}₺`);

        // Broadcast round complete
        io.emit('round_complete', {
            roundNumber: gameState.currentRound,
            winningNumber: winningNumber,
            totalBets: totalBets,
            totalPayouts: totalPayouts,
            winners: winners,
            phase: 'complete'
        });

        this.scheduleNextRound();
    }

    scheduleNextRound() {
        gameState.phase = 'waiting';
        
        setTimeout(() => {
            if (this.isRunning) {
                this.startNewRound();
            }
        }, ROUND_DELAY * 1000);
    }

    isWinningBet(bet, winningNumber) {
        switch (bet.type) {
            case 'number':
                return parseInt(bet.value) === winningNumber;
            case 'red':
                return winningNumber > 0 && [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36].includes(winningNumber);
            case 'black':
                return [2,4,6,8,10,11,13,15,17,20,22,24,26,28,29,31,33,35].includes(winningNumber);
            case 'even':
                return winningNumber > 0 && winningNumber % 2 === 0;
            case 'odd':
                return winningNumber % 2 === 1;
            case 'low':
                return winningNumber >= 1 && winningNumber <= 18;
            case 'high':
                return winningNumber >= 19 && winningNumber <= 36;
            case 'dozen':
                if (bet.value === '1st') return winningNumber >= 1 && winningNumber <= 12;
                if (bet.value === '2nd') return winningNumber >= 13 && winningNumber <= 24;
                if (bet.value === '3rd') return winningNumber >= 25 && winningNumber <= 36;
                return false;
            case 'column':
                if (bet.value === '1') return winningNumber > 0 && winningNumber % 3 === 1;
                if (bet.value === '2') return winningNumber > 0 && winningNumber % 3 === 2;
                if (bet.value === '3') return winningNumber > 0 && winningNumber % 3 === 0;
                return false;
            default:
                return false;
        }
    }

    getPayoutMultiplier(betType) {
        const multipliers = {
            'number': 35,
            'red': 1,
            'black': 1,
            'even': 1,
            'odd': 1,
            'low': 1,
            'high': 1,
            'dozen': 2,
            'column': 2
        };
        return multipliers[betType] || 1;
    }

    stop() {
        this.isRunning = false;
        if (this.countdownTimer) {
            clearInterval(this.countdownTimer);
        }
        console.log('🛑 Memory Rulet sistemi durduruldu');
    }
}

// Initialize game
const memoryGame = new MemoryRouletteGame();

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`👤 Kullanıcı bağlandı: ${socket.id}`);

    // Send current game state
    socket.emit('game_state', {
        phase: gameState.phase,
        betsOpen: gameState.betsOpen,
        countdown: gameState.countdown,
        currentRound: gameState.currentRound,
        winningNumber: gameState.winningNumber,
        lastWinners: gameState.lastWinners
    });

    // Handle user identification
    socket.on('identify_user', (data) => {
        socket.userId = data.userId;
        socket.username = data.username;
        
        // Update user session
        gameState.userSessions.set(data.userId, {
            socketId: socket.id,
            lastSeen: new Date(),
            username: data.username
        });
        
        console.log(`🔐 Kullanıcı tanımlandı: ${data.username} (${socket.id})`);
        
        socket.emit('identification_success', {
            message: 'WebSocket bağlantısı kuruldu',
            userId: data.userId
        });
    });

    // Handle bet placement (SADECE WEBSOCKET ÜZERİNDEN BİLGİ)
    socket.on('place_bet', (data) => {
        if (!gameState.betsOpen) {
            socket.emit('bet_failed', { message: 'Bahisler kapalı!' });
            return;
        }

        if (!socket.userId) {
            socket.emit('bet_failed', { message: 'Kullanıcı tanımlanmamış!' });
            return;
        }

        const { type, value, amount } = data;
        
        // Validate bet amount
        if (amount <= 0 || amount > 10000) {
            socket.emit('bet_failed', { message: 'Geçersiz bahis miktarı!' });
            return;
        }

        // Save bet to memory (validation hosting'de yapılacak)
        if (!gameState.currentBets.has(socket.userId)) {
            gameState.currentBets.set(socket.userId, []);
        }
        
        const multiplier = memoryGame.getPayoutMultiplier(type);
        const bet = {
            type,
            value,
            amount,
            multiplier,
            timestamp: new Date()
        };
        
        gameState.currentBets.get(socket.userId).push(bet);

        console.log(`💰 Bahis (Memory): ${socket.username} - ${type}:${value} - ${amount}₺`);

        // Confirm bet to user
        socket.emit('bet_confirmed', {
            type,
            value,
            amount,
            multiplier,
            message: 'Bahis alındı (doğrulama hosting\'de yapılacak)'
        });

        // Broadcast to others (optional)
        socket.broadcast.emit('new_bet_placed', {
            playerName: socket.username,
            bet: { type, value, amount }
        });
    });

    // Admin commands
    socket.on('admin_command', (data) => {
        if (data.secret !== ADMIN_SECRET) {
            socket.emit('admin_error', { message: 'Geçersiz admin şifresi!' });
            return;
        }

        console.log(`🔧 Admin komutu: ${data.command}`, data);

        switch (data.command) {
            case 'force_spin':
                if (gameState.betsOpen) {
                    memoryGame.closeBets();
                }
                setTimeout(() => {
                    memoryGame.spinWheel(data.forcedNumber);
                }, 1000);
                break;

            case 'get_stats':
                const stats = {
                    currentRound: gameState.currentRound,
                    phase: gameState.phase,
                    connectedUsers: gameState.userSessions.size,
                    totalBets: gameState.currentBets.size,
                    lastWinners: gameState.lastWinners
                };
                socket.emit('admin_stats', stats);
                break;

            default:
                socket.emit('admin_error', { message: 'Bilinmeyen komut!' });
        }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log(`👤 Kullanıcı ayrıldı: ${socket.id}`);
        
        if (socket.userId) {
            // Session'ı güncelle
            const userSession = gameState.userSessions.get(socket.userId);
            if (userSession) {
                userSession.socketId = null;
                userSession.lastSeen = new Date();
            }
        }
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        mode: 'memory-only',
        uptime: process.uptime(),
        connectedUsers: Array.from(gameState.userSessions.keys()).length,
        currentRound: gameState.currentRound,
        phase: gameState.phase
    });
});

// Start server
const PORT = process.env.PORT || 3001;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🎮 Memory Socket server çalışıyor: http://0.0.0.0:${PORT}`);
    console.log(`🌐 CORS: ${allowedOrigins.join(', ')}`);
    console.log(`📊 Mode: Memory-only (DB yok)`);
    
    // Start the memory game
    memoryGame.start();
});

module.exports = app;
