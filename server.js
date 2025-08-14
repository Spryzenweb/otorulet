// server.js (Tam Sürüm - Bakiye Tipi Düzeltmeleriyle)

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const ADMIN_SECRET_KEY = "gizli-anahtar";
const API_SECRET_KEY = 'BurayaCokGuvenliBirSifreYazin_12345_abcde';
const PHP_API_URL = 'https://bet.nesligida.com/rulet/api_update_balance.php';

const BET_TIME = 45000;
const SPIN_TIME = 8000;
const RESULT_TIME = 7000;
const PAYOUT_RATE = 36;

let gameState = 'IDLE';
let currentBets = {};
let playerData = {};
let gameLoopTimeout;

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
        console.log(`Veritabanı Güncelleme İsteği Başarılı: Kullanıcı ${userId}, Yeni Bakiye: ${newBalance}`);
    } catch (error) {
        console.error(`Veritabanı Güncelleme Hatası: Kullanıcı ${userId} için istek başarısız oldu.`);
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
        // DÜZELTME: Gelen bakiyenin her zaman sayı olduğundan emin oluyoruz.
        balance: parseFloat(initialData.balance !== undefined ? initialData.balance : 1000),
        name: initialData.name || 'Oyuncu'
    };
    
    socket.emit('update_balance', { newBalance: playerData[socket.id].balance });

    socket.on('place_bet', (data) => {
        if (gameState !== 'BETTING') {
            return socket.emit('bet_failed', { message: 'Bahisler şu an kapalı.' });
        }
        
        const player = playerData[socket.id];
        // DÜZELTME: Gelen bahis miktarının her zaman sayı olduğundan emin oluyoruz.
        const betAmount = parseFloat(data.amount);

        // DÜZELTME: Karşılaştırmadan önce oyuncu bakiyesinin de sayı olduğundan emin oluyoruz.
        if (!player || parseFloat(player.balance) < betAmount) {
            // Debug için log ekleyelim
            console.log(`Yetersiz Bakiye Hatası: Oyuncu ${player.name}, Sunucu Bakiyesi: ${player.balance} (tip: ${typeof player.balance}), Bahis Miktarı: ${betAmount} (tip: ${typeof betAmount})`);
            return socket.emit('bet_failed', { message: 'Yetersiz bakiye!' });
        }
        
        // DÜZELTME: Çıkarma işleminde her iki değerin de sayı olduğundan emin oluyoruz.
        player.balance = parseFloat(player.balance) - betAmount;
        
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
        // DÜZELTME: İade işleminde her iki değerin de sayı olduğundan emin oluyoruz.
        player.balance = parseFloat(player.balance) + parseFloat(betToCancel.amount);
        bets.splice(betIndex, 1);

        socket.emit('update_balance', { newBalance: player.balance });
        socket.emit('bet_cancelled_ok', { betId: data.betId, message: 'Bahis iptal edildi.' });
    });

    socket.on('disconnect', () => {
        console.log(`Bir kullanıcı ayrıldı: ${socket.id}`);
    });
    
    // Diğer olay dinleyicileri (admin_command vs.) aynı kalabilir.
});

function calculateAndDistributeWinnings(winningNumber) {
    console.log(`${winningNumber} için kazananlar hesaplanıyor...`);
    
    for (const socketId in currentBets) {
        if (!playerData[socketId]) continue;

        let totalWinnings = 0;
        const playerBets = currentBets[socketId];
        
        playerBets.forEach(bet => {
            if (parseInt(bet.value) === winningNumber) {
                totalWinnings += parseFloat(bet.amount) * PAYOUT_RATE;
            }
        });

        // Eğer bir kazanç varsa, bakiye güncellemesi yap
        if (totalWinnings > 0) {
            const player = playerData[socketId];
            // DÜZELTME: Toplama işleminde her iki değerin de sayı olduğundan emin oluyoruz. Bu en kritik düzeltme.
            player.balance = parseFloat(player.balance) + totalWinnings;
        }

        const player = playerData[socketId];
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

// Geri kalan fonksiyonlarda (startNewRound, startSpin, admin_command vb.) değişiklik yapmaya gerek yok.
// Sadece calculateAndDistributeWinnings ve io.on('connection') içindeki bakiye işlemlerini güncelledik.

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


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor.`);
    startNewRound();
});
