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

// Middleware
app.use(cors({
    origin: allowedOrigins,
    credentials: true
}));
app.use(express.json());

// Database instance
const db = new Database();

// Game state
const gameState = {
    currentRound: 0,
    sessionId: null,
    currentRoundId: null,
    betsOpen: false,
    countdown: 0,
    winningNumber: null,
    bets: new Map(), // userId -> Array of bets
    roundHistory: [],
    connectedUsers: new Map() // socketId -> userId
};

// Game configuration
const BETTING_DURATION = parseInt(process.env.BETTING_DURATION) || 30; // seconds
const ROUND_DELAY = parseInt(process.env.ROUND_DELAY) || 10; // seconds between rounds
const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY || 'gizli-anahtar';

// Game logic
class RouletteGame {
    constructor() {
        this.countdownTimer = null;
        this.roundTimer = null;
        this.isRunning = false;
    }

    async start() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        console.log('🎰 Rulet oyunu başlatılıyor...');
        
        try {
            // Create game session
            gameState.sessionId = await db.createGameSession();
            console.log(`📋 Oyun oturumu oluşturuldu: ${gameState.sessionId}`);
            
            // Start first round
            this.startNewRound();
        } catch (error) {
            console.error('Game start error:', error);
            this.isRunning = false;
        }
    }

    async startNewRound() {
        if (!this.isRunning) return;

        try {
            gameState.currentRound++;
            gameState.betsOpen = true;
            gameState.countdown = BETTING_DURATION;
            gameState.winningNumber = null;
            gameState.bets.clear();

            // Create round in database
            gameState.currentRoundId = await db.createGameRound(gameState.sessionId, gameState.currentRound);
            
            console.log(`🎯 Yeni tur başladı: ${gameState.currentRound}`);
            
            // Broadcast new round
            io.emit('new_round', {
                countdown: gameState.countdown,
                roundNumber: gameState.currentRound
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
            io.emit('countdown_update', { countdown: gameState.countdown });

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
        console.log('🔒 Bahisler kapandı');
        
        io.emit('bets_closed');

        // Wait a moment then spin
        setTimeout(() => {
            this.spinWheel();
        }, 2000);
    }

    async spinWheel(forcedNumber = null) {
        try {
            // Generate winning number
            const winningNumber = forcedNumber !== null ? forcedNumber : Math.floor(Math.random() * 37); // 0-36
            gameState.winningNumber = winningNumber;

            console.log(`🎰 Çark sonucu: ${winningNumber}`);
            
            // Broadcast spin result
            io.emit('spin_result', { number: winningNumber });

            // Wait for animation then process results
            setTimeout(async () => {
                await this.processRoundResults(winningNumber);
            }, 8000); // 8 seconds for wheel animation
        } catch (error) {
            console.error('Spin wheel error:', error);
        }
    }

    async processRoundResults(winningNumber) {
        try {
            let totalBets = 0;
            let totalPayouts = 0;
            const userResults = new Map();

            // Calculate payouts for each user
            for (const [userId, userBets] of gameState.bets) {
                let userTotalBet = 0;
                let userTotalPayout = 0;

                for (const bet of userBets) {
                    userTotalBet += bet.amount;
                    totalBets += bet.amount;

                    if (this.isWinningBet(bet, winningNumber)) {
                        const payout = bet.amount * bet.multiplier;
                        userTotalPayout += payout;
                        totalPayouts += payout;
                    }
                }

                if (userTotalPayout > 0) {
                    // User won
                    const newBalance = await db.getUserBalance(userId);
                    await db.updateUserBalance(
                        userId, 
                        newBalance + userTotalPayout, 
                        'win', 
                        `Rulet kazancı - Tur ${gameState.currentRound}`
                    );
                    
                    userResults.set(userId, {
                        newBalance: newBalance + userTotalPayout,
                        winAmount: userTotalPayout,
                        message: `Tebrikler! ${userTotalPayout} ₺ kazandınız!`
                    });
                } else {
                    // User lost
                    const newBalance = await db.getUserBalance(userId);
                    userResults.set(userId, {
                        newBalance: newBalance,
                        winAmount: 0,
                        message: `Maalesef kaybettiniz. Yeni bakiye: ${newBalance} ₺`
                    });
                }
            }

            // Finish round in database
            await db.finishRound(gameState.currentRoundId, winningNumber, totalBets, totalPayouts);

            // Send results to each user
            for (const [userId, result] of userResults) {
                const userSockets = Array.from(io.sockets.sockets.values())
                    .filter(socket => socket.userId === userId);
                
                userSockets.forEach(socket => {
                    socket.emit('round_result', result);
                });
            }

            // Add to history
            gameState.roundHistory.unshift({
                round: gameState.currentRound,
                number: winningNumber,
                timestamp: new Date(),
                totalBets,
                totalPayouts,
                profit: totalBets - totalPayouts
            });

            // Keep only last 50 rounds in memory
            if (gameState.roundHistory.length > 50) {
                gameState.roundHistory = gameState.roundHistory.slice(0, 50);
            }

            console.log(`📊 Tur ${gameState.currentRound} tamamlandı. Kazanan: ${winningNumber}, Bahis: ${totalBets}₺, Ödeme: ${totalPayouts}₺`);

            // Start next round after delay
            setTimeout(() => {
                if (this.isRunning) {
                    this.startNewRound();
                }
            }, ROUND_DELAY * 1000);

        } catch (error) {
            console.error('Process round results error:', error);
        }
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
        console.log('🛑 Rulet oyunu durduruldu');
    }
}

// Initialize game
const rouletteGame = new RouletteGame();

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`👤 Kullanıcı bağlandı: ${socket.id}`);

    // Send current game state
    socket.emit('game_state', {
        betsOpen: gameState.betsOpen,
        countdown: gameState.countdown,
        currentRound: gameState.currentRound,
        winningNumber: gameState.winningNumber,
        roundHistory: gameState.roundHistory.slice(0, 10)
    });

    // Handle user identification
    socket.on('identify_user', (data) => {
        socket.userId = data.userId;
        socket.username = data.username;
        gameState.connectedUsers.set(socket.id, data.userId);
        
        console.log(`🔐 Kullanıcı tanımlandı: ${data.username} (${socket.id})`);
        
        db.logAction(data.userId, 'socket_connected', { socketId: socket.id }, socket.handshake.address);
    });

    // Handle bet placement
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

            // Check user balance
            const userBalance = await db.getUserBalance(socket.userId);
            if (userBalance < amount) {
                socket.emit('bet_failed', { message: 'Yetersiz bakiye!' });
                return;
            }

            // Deduct bet amount from user balance
            await db.updateUserBalance(
                socket.userId, 
                userBalance - amount, 
                'bet', 
                `Rulet bahisi - Tur ${gameState.currentRound}`,
                gameState.currentRoundId
            );

            // Save bet to database
            const multiplier = rouletteGame.getPayoutMultiplier(type);
            await db.saveBet(socket.userId, gameState.currentRoundId, type, value, amount, multiplier);

            // Add bet to game state
            if (!gameState.bets.has(socket.userId)) {
                gameState.bets.set(socket.userId, []);
            }
            
            gameState.bets.get(socket.userId).push({
                type,
                value,
                amount,
                multiplier,
                timestamp: new Date()
            });

            console.log(`💰 Bahis yapıldı: ${socket.username} - ${type}:${value} - ${amount}₺`);

            // Confirm bet to user
            socket.emit('bet_confirmed', {
                type,
                value,
                amount,
                newBalance: userBalance - amount
            });

            // Broadcast bet to other players
            socket.broadcast.emit('new_bet_placed', {
                playerName: socket.username,
                bet: { type, value, amount }
            });

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
                        rouletteGame.closeBets();
                    }
                    setTimeout(() => {
                        rouletteGame.spinWheel(data.forcedNumber);
                    }, 1000);
                    
                    // Log admin action
                    if (socket.userId) {
                        await db.query(
                            'INSERT INTO admin_actions (admin_user_id, action_type, action_data, description) VALUES (?, ?, ?, ?)',
                            [
                                socket.userId,
                                'force_spin',
                                JSON.stringify({ forcedNumber: data.forcedNumber }),
                                `Force spin command: ${data.forcedNumber !== null ? data.forcedNumber : 'random'}`
                            ]
                        );
                    }
                    break;

                case 'get_stats':
                    const stats = {
                        currentRound: gameState.currentRound,
                        connectedUsers: gameState.connectedUsers.size,
                        totalBets: gameState.bets.size,
                        roundHistory: gameState.roundHistory.slice(0, 10)
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
            db.logAction(socket.userId, 'socket_disconnected', { socketId: socket.id }, socket.handshake.address);
        }
        
        gameState.connectedUsers.delete(socket.id);
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        connectedUsers: gameState.connectedUsers.size,
        currentRound: gameState.currentRound,
        betsOpen: gameState.betsOpen
    });
});

// Start server - Use Render's dynamic PORT
const PORT = process.env.PORT || 3001;

server.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Socket server çalışıyor: http://0.0.0.0:${PORT}`);
    console.log(`🌐 CORS: ${allowedOrigins.join(', ')}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV}`);
    
    // Start the roulette game
    await rouletteGame.start();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('🛑 Server kapanıyor...');
    rouletteGame.stop();
    await db.close();
    server.close();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('🛑 Server kapanıyor...');
    rouletteGame.stop();
    await db.close();
    server.close();
    process.exit(0);
});
