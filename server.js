const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config({ path: './config.env' });

const Database = require('./database');

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

const db = new Database();

// GÜVENLİ OYUN DURUMU - Sadece server'da
const gameState = {
    currentRound: 0,
    sessionId: null,
    currentRoundId: null,
    betsOpen: false,
    countdown: 0,
    winningNumber: null,
    phase: 'waiting', // waiting, betting, spinning, calculating
    
    // Kullanıcı rulet bakiyeleri (site bakiyesinden ayrı)
    rouletteBalances: new Map(), // userId -> rouletteBalance
    
    // Aktif bahisler (round bazında)
    roundBets: new Map(), // roundId -> Map(userId -> [bets])
    
    // Kullanıcı sessionları (bağlantı kopması koruması)
    userSessions: new Map(), // userId -> { socketId, lastSeen, pendingWins }
    
    // Bekleme listesi (bağlantı kopan kullanıcılar için)
    pendingPayouts: new Map() // userId -> amount
};

// Game configuration
const BETTING_DURATION = parseInt(process.env.BETTING_DURATION) || 30;
const ROUND_DELAY = parseInt(process.env.ROUND_DELAY) || 10;
const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY || 'gizli-anahtar';

class SecureRouletteGame {
    constructor() {
        this.countdownTimer = null;
        this.roundTimer = null;
        this.isRunning = false;
    }

    async start() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        console.log('🔒 Güvenli Rulet sistemi başlatılıyor...');
        
        try {
            // Create game session
            gameState.sessionId = await db.createGameSession();
            console.log(`📋 Oyun oturumu oluşturuldu: ${gameState.sessionId}`);
            
            // Bekleyen ödemeleri yükle
            await this.loadPendingPayouts();
            
            // Start first round
            this.startNewRound();
        } catch (error) {
            console.error('Game start error:', error);
            this.isRunning = false;
        }
    }

    async loadPendingPayouts() {
        try {
            // Veritabanından tamamlanmamış ödemeleri yükle
            const query = `
                SELECT user_id, SUM(win_amount) as total_pending 
                FROM pending_payouts 
                WHERE status = 'pending' 
                GROUP BY user_id
            `;
            const result = await db.query(query);
            
            result.forEach(row => {
                gameState.pendingPayouts.set(row.user_id, row.total_pending);
            });
            
            console.log(`💰 ${result.length} kullanıcı için bekleyen ödeme yüklendi`);
        } catch (error) {
            console.error('Pending payouts load error:', error);
        }
    }

    async startNewRound() {
        if (!this.isRunning) return;

        try {
            gameState.currentRound++;
            gameState.phase = 'betting';
            gameState.betsOpen = true;
            gameState.countdown = BETTING_DURATION;
            gameState.winningNumber = null;
            
            // Yeni round için bahis mapini temizle
            gameState.roundBets.set(gameState.currentRound, new Map());

            // Create round in database
            gameState.currentRoundId = await db.createGameRound(gameState.sessionId, gameState.currentRound);
            
            console.log(`🎯 Yeni tur başladı: ${gameState.currentRound}`);
            
            // Broadcast new round (sadece gerekli bilgiler)
            io.emit('new_round', {
                roundNumber: gameState.currentRound,
                countdown: gameState.countdown,
                phase: gameState.phase,
                betsOpen: gameState.betsOpen
            });

            // Start countdown
            this.startCountdown();
        } catch (error) {
            console.error('New round error:', error);
        }
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

    async spinWheel(forcedNumber = null) {
        try {
            gameState.phase = 'spinning';
            
            // Generate winning number
            const winningNumber = forcedNumber !== null ? forcedNumber : Math.floor(Math.random() * 37);
            gameState.winningNumber = winningNumber;

            console.log(`🎰 Çark sonucu: ${winningNumber}`);
            
            // Broadcast spin result
            io.emit('spin_result', { 
                number: winningNumber,
                phase: gameState.phase
            });

            // Update database immediately
            await db.finishRound(gameState.currentRoundId, winningNumber, 0, 0);

            // Wait for animation then process results
            setTimeout(async () => {
                await this.processRoundResults(winningNumber);
            }, 8000);
        } catch (error) {
            console.error('Spin wheel error:', error);
        }
    }

    async processRoundResults(winningNumber) {
        try {
            gameState.phase = 'calculating';
            
            const currentRoundBets = gameState.roundBets.get(gameState.currentRound);
            if (!currentRoundBets) {
                console.log('Bu turda bahis yok');
                this.scheduleNextRound();
                return;
            }

            let totalBets = 0;
            let totalPayouts = 0;
            const payoutPromises = [];

            // Her kullanıcının bahislerini işle
            for (const [userId, userBets] of currentRoundBets) {
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

                // Kazancı işle (eğer varsa)
                if (userTotalWin > 0) {
                    payoutPromises.push(this.processUserPayout(userId, userTotalWin));
                }

                console.log(`👤 User ${userId}: Bahis: ${userTotalBet}₺, Kazanç: ${userTotalWin}₺`);
            }

            // Tüm ödemeleri paralel işle
            await Promise.all(payoutPromises);

            // Update round stats
            await db.query(
                'UPDATE game_rounds SET total_bets = ?, total_payouts = ? WHERE id = ?',
                [totalBets, totalPayouts, gameState.currentRoundId]
            );

            console.log(`📊 Tur ${gameState.currentRound} tamamlandı. Bahis: ${totalBets}₺, Ödeme: ${totalPayouts}₺`);

            // Broadcast round complete
            io.emit('round_complete', {
                roundNumber: gameState.currentRound,
                winningNumber: winningNumber,
                totalBets: totalBets,
                totalPayouts: totalPayouts,
                phase: 'complete'
            });

            this.scheduleNextRound();

        } catch (error) {
            console.error('Process round results error:', error);
            this.scheduleNextRound();
        }
    }

    async processUserPayout(userId, winAmount) {
        try {
            // Site bakiyesine ekle (güvenli)
            const currentBalance = await db.getUserBalance(userId);
            const newBalance = currentBalance + winAmount;
            
            await db.updateUserBalance(
                userId, 
                newBalance, 
                'roulette_win', 
                `Rulet kazancı - Tur ${gameState.currentRound}`
            );

            // Kullanıcıya bildir (eğer bağlıysa)
            const userSession = gameState.userSessions.get(userId);
            if (userSession && userSession.socketId) {
                const socket = io.sockets.sockets.get(userSession.socketId);
                if (socket) {
                    socket.emit('payout_received', {
                        amount: winAmount,
                        newBalance: newBalance,
                        roundNumber: gameState.currentRound
                    });
                }
            } else {
                // Kullanıcı bağlı değil, pending payouts'a ekle
                const pending = gameState.pendingPayouts.get(userId) || 0;
                gameState.pendingPayouts.set(userId, pending + winAmount);
                
                await db.query(
                    'INSERT INTO pending_payouts (user_id, win_amount, round_id, status) VALUES (?, ?, ?, ?)',
                    [userId, winAmount, gameState.currentRoundId, 'pending']
                );
            }

        } catch (error) {
            console.error(`User ${userId} payout error:`, error);
        }
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
        if (this.roundTimer) {
            clearTimeout(this.roundTimer);
        }
        console.log('🛑 Güvenli Rulet sistemi durduruldu');
    }
}

// Initialize game
const secureGame = new SecureRouletteGame();

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`👤 Kullanıcı bağlandı: ${socket.id}`);

    // Send current game state (sadece gerekli bilgiler)
    socket.emit('game_state', {
        phase: gameState.phase,
        betsOpen: gameState.betsOpen,
        countdown: gameState.countdown,
        currentRound: gameState.currentRound,
        winningNumber: gameState.winningNumber
    });

    // Handle user identification
    socket.on('identify_user', async (data) => {
        try {
            socket.userId = data.userId;
            socket.username = data.username;
            
            // Update user session
            gameState.userSessions.set(data.userId, {
                socketId: socket.id,
                lastSeen: new Date(),
                username: data.username
            });
            
            console.log(`🔐 Kullanıcı tanımlandı: ${data.username} (${socket.id})`);
            
            // Bekleyen ödemeleri kontrol et ve gönder
            const pendingAmount = gameState.pendingPayouts.get(data.userId);
            if (pendingAmount > 0) {
                const currentBalance = await db.getUserBalance(data.userId);
                
                socket.emit('pending_payout', {
                    amount: pendingAmount,
                    message: `Bağlantınız kesilirken ${pendingAmount}₺ kazandınız!`,
                    newBalance: currentBalance
                });
                
                // Pending'i temizle
                gameState.pendingPayouts.delete(data.userId);
                await db.query(
                    'UPDATE pending_payouts SET status = ? WHERE user_id = ? AND status = ?',
                    ['delivered', data.userId, 'pending']
                );
            }
            
            // Rulet bakiyesini gönder
            const rouletteBalance = gameState.rouletteBalances.get(data.userId) || 0;
            socket.emit('roulette_balance', { balance: rouletteBalance });
            
        } catch (error) {
            console.error('User identification error:', error);
        }
    });

    // Handle roulette balance transfer
    socket.on('transfer_to_roulette', async (data) => {
        try {
            if (!socket.userId) {
                socket.emit('transfer_failed', { message: 'Kullanıcı tanımlanmamış!' });
                return;
            }

            const { amount } = data;
            
            if (amount <= 0 || amount > 100000) {
                socket.emit('transfer_failed', { message: 'Geçersiz transfer miktarı!' });
                return;
            }

            // Site bakiyesini kontrol et
            const siteBalance = await db.getUserBalance(socket.userId);
            if (siteBalance < amount) {
                socket.emit('transfer_failed', { message: 'Yetersiz site bakiyesi!' });
                return;
            }

            // Site bakiyesinden düş
            await db.updateUserBalance(
                socket.userId,
                siteBalance - amount,
                'roulette_transfer',
                `Rulete transfer: ${amount}₺`
            );

            // Rulet bakiyesine ekle
            const currentRouletteBalance = gameState.rouletteBalances.get(socket.userId) || 0;
            gameState.rouletteBalances.set(socket.userId, currentRouletteBalance + amount);

            socket.emit('transfer_success', {
                transferAmount: amount,
                newSiteBalance: siteBalance - amount,
                newRouletteBalance: currentRouletteBalance + amount
            });

            console.log(`💸 Transfer: ${socket.username} - ${amount}₺ rulete aktarıldı`);

        } catch (error) {
            console.error('Transfer error:', error);
            socket.emit('transfer_failed', { message: 'Transfer işlemi başarısız!' });
        }
    });

    // Handle bet placement (server-side validation)
    socket.on('place_bet', async (data) => {
        try {
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

            // Check roulette balance
            const rouletteBalance = gameState.rouletteBalances.get(socket.userId) || 0;
            if (rouletteBalance < amount) {
                socket.emit('bet_failed', { message: 'Yetersiz rulet bakiyesi!' });
                return;
            }

            // Rulet bakiyesinden düş (server-side)
            gameState.rouletteBalances.set(socket.userId, rouletteBalance - amount);

            // Save bet to current round
            const currentRoundBets = gameState.roundBets.get(gameState.currentRound);
            if (!currentRoundBets.has(socket.userId)) {
                currentRoundBets.set(socket.userId, []);
            }
            
            const multiplier = secureGame.getPayoutMultiplier(type);
            const bet = {
                type,
                value,
                amount,
                multiplier,
                timestamp: new Date()
            };
            
            currentRoundBets.get(socket.userId).push(bet);

            // Save bet to database
            await db.saveBet(socket.userId, gameState.currentRoundId, type, value, amount, multiplier);

            console.log(`💰 Bahis yapıldı: ${socket.username} - ${type}:${value} - ${amount}₺`);

            // Confirm bet to user
            socket.emit('bet_confirmed', {
                type,
                value,
                amount,
                multiplier,
                newRouletteBalance: rouletteBalance - amount
            });

            // Update last seen
            const userSession = gameState.userSessions.get(socket.userId);
            if (userSession) {
                userSession.lastSeen = new Date();
            }

        } catch (error) {
            console.error('Place bet error:', error);
            socket.emit('bet_failed', { message: 'Bahis işlemi başarısız!' });
        }
    });

    // Admin commands
    socket.on('admin_command', async (data) => {
        try {
            if (data.secret !== ADMIN_SECRET) {
                socket.emit('admin_error', { message: 'Geçersiz admin şifresi!' });
                return;
            }

            console.log(`🔧 Admin komutu: ${data.command}`, data);

            switch (data.command) {
                case 'force_spin':
                    if (gameState.betsOpen) {
                        secureGame.closeBets();
                    }
                    setTimeout(() => {
                        secureGame.spinWheel(data.forcedNumber);
                    }, 1000);
                    break;

                case 'get_stats':
                    const stats = {
                        currentRound: gameState.currentRound,
                        phase: gameState.phase,
                        connectedUsers: gameState.userSessions.size,
                        totalBets: gameState.roundBets.size,
                        pendingPayouts: gameState.pendingPayouts.size
                    };
                    socket.emit('admin_stats', stats);
                    break;

                default:
                    socket.emit('admin_error', { message: 'Bilinmeyen komut!' });
            }
        } catch (error) {
            console.error('Admin command error:', error);
            socket.emit('admin_error', { message: 'Komut işlenemedi!' });
        }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log(`👤 Kullanıcı ayrıldı: ${socket.id}`);
        
        if (socket.userId) {
            // Session'ı güncelle ama silme (bağlantı kopması koruması)
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
        uptime: process.uptime(),
        connectedUsers: Array.from(gameState.userSessions.keys()).length,
        currentRound: gameState.currentRound,
        phase: gameState.phase,
        pendingPayouts: gameState.pendingPayouts.size
    });
});

// Start server - Use Render's dynamic PORT
const PORT = process.env.PORT || 3001;

server.listen(PORT, '0.0.0.0', async () => {
    console.log(`🔒 Güvenli Socket server çalışıyor: http://0.0.0.0:${PORT}`);
    console.log(`🌐 CORS: ${allowedOrigins.join(', ')}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV}`);
    
    // Start the secure roulette game
    await secureGame.start();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('🛑 Server kapanıyor...');
    secureGame.stop();
    await db.close();
    server.close();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('🛑 Server kapanıyor...');
    secureGame.stop();
    await db.close();
    server.close();
    process.exit(0);
});

module.exports = app;