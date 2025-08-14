// server.js (Geliştirilmiş Tam Sürüm)

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- GÜVENLİK VE API AYARLARI ---
const ADMIN_SECRET_KEY = "gizli-anahtar";
const API_SECRET_KEY = 'BurayaCokGuvenliBirSifreYazin_12345_abcde';
const PHP_API_URL = 'https://bet.nesligida.com/rulet/api_update_balance.php';

// --- OYUN AYARLARI ---
const BET_TIME = 20000; // 20 saniye
const SPIN_TIME = 8000;  // 8 saniye
const RESULT_TIME = 7000; // 7 saniye

// --- OYUN SABİTELERİ ---
const RED_NUMBERS = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
const BLACK_NUMBERS = [2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35];

// --- OYUN DURUMLARI ---
let gameState = 'IDLE';
let currentBets = {}; // { socketId: [{ betId, type, value, amount }] }
let playerData = {}; // { socketId: { userId, balance, name } }
let gameLoopTimeout, bettingEndTime;

// Sunucudan PHP'ye bakiye güncelleme isteği gönderen fonksiyon
async function updateUserBalanceInDB(userId, newBalance) {
    try {
        await axios.post(PHP_API_URL, {
            userId: userId,
            newBalance: parseFloat(newBalance).toFixed(2)
        }, {
            headers: {
                'Content-Type': 'application/json',
                'X-Auth-Token': API_SECRET_KEY
            }
        });
        console.log(`Veritabanı Güncelleme Başarılı: Kullanıcı ${userId}, Yeni Bakiye: ${newBalance}`);
    } catch (error) {
        console.error(`Veritabanı Güncelleme Hatası: Kullanıcı ${userId}. Detay:`, error.message);
    }
}

io.on('connection', (socket) => {
    console.log(`Bir kullanıcı bağlandı: ${socket.id}`);
    const initialData = socket.handshake.auth;

    if (!initialData.userId) {
        return socket.disconnect();
    }
    
    playerData[socket.id] = {
        userId: initialData.userId,
        balance: initialData.balance !== undefined ? parseFloat(initialData.balance) : 1000,
        name: initialData.name || 'Oyuncu'
    };
    
    socket.emit('update_balance', { newBalance: playerData[socket.id].balance });

    if (gameState === 'BETTING') {
        const remainingTime = Math.max(0, Math.round((bettingEndTime - Date.now()) / 1000));
        socket.emit('new_round', { 
            countdown: remainingTime,
            allBets: getAllActiveBets() // Mevcut tüm bahisleri yeni bağlanan oyuncuya gönder
        });
    }

    socket.on('place_bet', (data) => {
        if (gameState !== 'BETTING') {
            return socket.emit('bet_failed', { message: 'Bahisler şu an kapalı.' });
        }
        const player = playerData[socket.id];
        const betAmount = parseFloat(data.amount);

        if (!player || isNaN(betAmount) || betAmount <= 0) {
            return socket.emit('bet_failed', { message: 'Geçersiz bahis miktarı.' });
        }
        if (player.balance < betAmount) {
            return socket.emit('bet_failed', { message: 'Yetersiz bakiye!' });
        }

        player.balance -= betAmount;
        if (!currentBets[socket.id]) {
            currentBets[socket.id] = [];
        }

        const betId = `${Date.now()}_${socket.id}_${Math.random()}`;
        const newBet = {
            betId: betId,
            type: data.type, // 'number', 'color', 'dozen', 'range', 'parity'
            value: data.value, // 0-36, 'red', 'black', '1st12', '1-18', 'even'
            amount: betAmount
        };
        currentBets[socket.id].push(newBet);
        
        socket.emit('update_balance', { newBalance: player.balance });

        // Bahsi tüm oyunculara yayınla
        io.emit('new_bet_placed', {
            playerName: player.name,
            bet: newBet
        });
    });

    socket.on('disconnect', () => {
        console.log(`Bir kullanıcı ayrıldı: ${socket.id}`);
        // İsteğe bağlı: Oyuncu ayrıldığında bahislerini iptal etme mantığı eklenebilir.
        // delete playerData[socket.id];
        // delete currentBets[socket.id];
    });

    // Admin komutları değişmedi, olduğu gibi kalabilir.
    socket.on('admin_command', (data) => {
        if (data.secret !== ADMIN_SECRET_KEY) return;
        if (data.command === 'force_spin') {
            clearTimeout(gameLoopTimeout);
            startSpin(data.forcedNumber);
        }
    });
});

function getAllActiveBets() {
    const allBets = [];
    for (const socketId in currentBets) {
        if (playerData[socketId]) {
            currentBets[socketId].forEach(bet => {
                allBets.push({ playerName: playerData[socketId].name, bet });
            });
        }
    }
    return allBets;
}

function startNewRound() {
    gameState = 'BETTING';
    currentBets = {};
    
    const countdown = BET_TIME / 1000;
    io.emit('new_round', { countdown: countdown, allBets: [] });
    console.log(`Yeni tur başlatıldı. Bahisler ${countdown} saniye boyunca açık.`);
    
    bettingEndTime = Date.now() + BET_TIME;
    gameLoopTimeout = setTimeout(() => startSpin(null), BET_TIME);
}

function startSpin(forcedNumber = null) {
    gameState = 'SPINNING';
    io.emit('bets_closed');
    const winningNumber = (forcedNumber !== null && forcedNumber >= 0 && forcedNumber <= 36)
        ? forcedNumber
        : Math.floor(Math.random() * 37);
    
    io.emit('spin_result', { number: winningNumber });
    console.log(`Çark dönüyor... Kazanan sayı: ${winningNumber}`);
    setTimeout(() => calculateAndDistributeWinnings(winningNumber), SPIN_TIME);
}

function calculateAndDistributeWinnings(winningNumber) {
    console.log(`${winningNumber} için kazananlar hesaplanıyor...`);
    
    for (const socketId in currentBets) {
        if (!playerData[socketId]) continue;

        let totalWinnings = 0;
        const player = playerData[socketId];
        const playerBets = currentBets[socketId];
        
        playerBets.forEach(bet => {
            let winMultiplier = 0;
            switch (bet.type) {
                case 'number':
                    if (parseInt(bet.value) === winningNumber) winMultiplier = 36;
                    break;
                case 'color':
                    if (bet.value === 'red' && RED_NUMBERS.includes(winningNumber)) winMultiplier = 2;
                    if (bet.value === 'black' && BLACK_NUMBERS.includes(winningNumber)) winMultiplier = 2;
                    if (bet.value === 'green' && winningNumber === 0) winMultiplier = 36;
                    break;
                case 'parity':
                    if (winningNumber !== 0) {
                        if (bet.value === 'even' && winningNumber % 2 === 0) winMultiplier = 2;
                        if (bet.value === 'odd' && winningNumber % 2 !== 0) winMultiplier = 2;
                    }
                    break;
                case 'range':
                    if (winningNumber >= 1 && winningNumber <= 18 && bet.value === '1-18') winMultiplier = 2;
                    if (winningNumber >= 19 && winningNumber <= 36 && bet.value === '19-36') winMultiplier = 2;
                    break;
                case 'dozen':
                    if (winningNumber >= 1 && winningNumber <= 12 && bet.value === '1st12') winMultiplier = 3;
                    if (winningNumber >= 13 && winningNumber <= 24 && bet.value === '2nd12') winMultiplier = 3;
                    if (winningNumber >= 25 && winningNumber <= 36 && bet.value === '3rd12') winMultiplier = 3;
                    break;
            }
            if (winMultiplier > 0) {
                totalWinnings += bet.amount * winMultiplier;
            }
        });

        if (totalWinnings > 0) {
            player.balance += totalWinnings;
            const playerSocket = io.sockets.sockets.get(socketId);
            if (playerSocket) {
                playerSocket.emit('round_result', { 
                    message: `Tebrikler! ${totalWinnings.toLocaleString('tr-TR')} ₺ kazandınız!`,
                    newBalance: player.balance,
                    winAmount: totalWinnings
                });
            }
        }
        
        // Kazansın veya kaybetsin, son bakiye veritabanına kaydedilir.
        updateUserBalanceInDB(player.userId, player.balance);
    }

    console.log("Tur bitti. Yeni tur için bekleniyor...");
    gameState = 'IDLE';
    gameLoopTimeout = setTimeout(startNewRound, RESULT_TIME);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor.`);
    startNewRound();
});
