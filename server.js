// server.js (Tam Sürüm - API URL'si ve Canlıya Katılma Düzeltmesiyle Birlikte)

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios'); // HTTP istekleri için

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- GÜVENLİK VE API AYARLARI ---
const ADMIN_SECRET_KEY = "gizli-anahtar";
const API_SECRET_KEY = 'BurayaCokGuvenliBirSifreYazin_12345_abcde'; // PHP dosyasındakiyle %100 aynı olmalı!
const PHP_API_URL = 'https://bet.nesligida.com/rulet/api_update_balance.php'; // SİZİN TARAFINIZDAN SAĞLANAN GÜNCEL URL

// --- OYUN AYARLARI ---
const BET_TIME = 45000;
const SPIN_TIME = 8000;
const RESULT_TIME = 7000;
const PAYOUT_RATE = 36;

// --- OYUN DURUMLARI ---
let gameState = 'IDLE';
let currentBets = {};
let playerData = {};
let gameLoopTimeout, bettingEndTime; // Canlıya katılma için bettingEndTime eklendi

// Sunucudan PHP'ye bakiye güncelleme isteği gönderen fonksiyon
async function updateUserBalanceInDB(userId, newBalance) {
    try {
        console.log(`Veritabanı Güncelleme İsteği Gönderiliyor: Kullanıcı ${userId}, Bakiye: ${newBalance}, URL: ${PHP_API_URL}`);
        await axios.post(PHP_API_URL, {
            userId: userId,
            newBalance: parseFloat(newBalance).toFixed(2)
        }, {
            headers: {
                'Content-Type': 'application/json',
                'X-Auth-Token': API_SECRET_KEY // Güvenlik anahtarını header'da gönder
            }
        });
        console.log(`Veritabanı Güncelleme İsteği Başarılı: Kullanıcı ${userId}, Yeni Bakiye: ${newBalance}`);
    } catch (error) {
        console.error(`Veritabanı Güncelleme Hatası: Kullanıcı ${userId} için istek başarısız oldu.`);
        // Hata detaylarını görmek için bu satırları kullanabilirsiniz, Render loglarında çok faydalı olacaktır:
        if (error.response) {
            console.error('Hata Detayı (Sunucudan Gelen Cevap):', error.response.data);
            console.error('Hata Kodu:', error.response.status);
        } else if (error.request) {
            console.error('Hata Detayı (İstek Yapıldı Ama Cevap Alınamadı):', error.request);
        } else {
            console.error('Hata Detayı (Genel Hata):', error.message);
        }
    }
}


io.on('connection', (socket) => {
    console.log(`Bir kullanıcı bağlandı: ${socket.id}`);
    const initialData = socket.handshake.auth;

    if (!initialData.userId) {
        console.log(`Bağlantı reddedildi: Kullanıcı ID'si yok. Socket ID: ${socket.id}`);
        return socket.disconnect();
    }
    
    playerData[socket.id] = {
        userId: initialData.userId,
        balance: initialData.balance !== undefined ? parseFloat(initialData.balance) : 1000,
        name: initialData.name || 'Oyuncu'
    };
    
    socket.emit('update_balance', { newBalance: playerData[socket.id].balance });

    // Eğer oyuncu bağlandığında bahis turu devam ediyorsa, onu mevcut tura dahil et.
    if (gameState === 'BETTING') {
        const remainingTime = Math.max(0, Math.round((bettingEndTime - Date.now()) / 1000));
        if (remainingTime > 0) {
            socket.emit('new_round', { countdown: remainingTime });
        }
    }

    socket.on('place_bet', (data) => {
        if (gameState !== 'BETTING') {
            return socket.emit('bet_failed', { message: 'Bahisler şu an kapalı.' });
        }
        const player = playerData[socket.id];
        const betAmount = parseFloat(data.amount);
        if (!player || player.balance < betAmount) {
            return socket.emit('bet_failed', { message: 'Yetersiz bakiye!' });
        }
        player.balance -= betAmount;
        if (!currentBets[socket.id]) {
            currentBets[socket.id] = [];
        }
        const betId = Date.now() + "_" + socket.id;
        const newBet = { betId: betId, value: data.value, amount: betAmount };
        currentBets[socket.id].push(newBet);
        socket.emit('update_balance', { newBalance: player.balance });
        socket.emit('bet_successful', newBet);
    });

    socket.on('cancel_bet', (data) => {
        if (gameState !== 'BETTING') return;
        const player = playerData[socket.id];
        const bets = currentBets[socket.id];
        if (!player || !bets) return;
        const betIndex = bets.findIndex(b => b.betId === data.betId);
        if (betIndex === -1) return;
        const betToCancel = bets[betIndex];
        player.balance += betToCancel.amount;
        bets.splice(betIndex, 1);
        socket.emit('update_balance', { newBalance: player.balance });
        socket.emit('bet_cancelled_ok', { betId: data.betId, message: 'Bahis iptal edildi.' });
    });

    socket.on('admin_command', (data) => {
         if (data.secret !== ADMIN_SECRET_KEY) {
            console.log("Geçersiz admin anahtarı ile komut denemesi.");
            return socket.emit('admin_feedback', 'Hata: Geçersiz admin anahtarı!');
        }
        console.log(`Admin komutu alındı: ${data.command}`);
        socket.emit('admin_feedback', `Komut '${data.command}' başarıyla işlendi.`);

        if (data.command === 'force_spin') {
            clearTimeout(gameLoopTimeout);
            startSpin(data.forcedNumber);
        }
    });

    socket.on('disconnect', () => {
        console.log(`Bir kullanıcı ayrıldı: ${socket.id}`);
    });
});

function startNewRound() {
    gameState = 'BETTING';
    const connectedPlayerSocketIds = Object.keys(io.sockets.sockets);
    currentBets = {};
    playerData = Object.keys(playerData)
        .filter(socketId => connectedPlayerSocketIds.includes(socketId))
        .reduce((res, key) => (res[key] = playerData[key], res), {});

    const countdown = BET_TIME / 1000;
    io.emit('new_round', { countdown: countdown });
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
    setTimeout(() => calculateAndDistributeWinnings(winningNumber), SPIN_TIME);
}

function calculateAndDistributeWinnings(winningNumber) {
    console.log(`${winningNumber} için kazananlar hesaplanıyor...`);
    
    for (const socketId in currentBets) {
        if (!playerData[socketId]) continue;

        let totalWinnings = 0;
        const playerBets = currentBets[socketId];
        
        playerBets.forEach(bet => {
            if (parseInt(bet.value) === winningNumber) {
                totalWinnings += bet.amount * PAYOUT_RATE;
            }
        });

        const player = playerData[socketId];
        player.balance += totalWinnings;

        updateUserBalanceInDB(player.userId, player.balance);
        
        const playerSocket = io.sockets.sockets.get(socketId);
        if (playerSocket) {
            let resultMessage = "";
            if (totalWinnings > 0) {
                resultMessage = `Tebrikler! ${totalWinnings.toLocaleString('tr-TR')} ₺ kazandınız!`;
            } else {
                resultMessage = `Bu tur kazanamadınız. Kazanan sayı: ${winningNumber}.`;
            }
             playerSocket.emit('round_result', { 
                message: resultMessage,
                newBalance: player.balance 
            });
        }
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
