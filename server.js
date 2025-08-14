// server.js (Tam Sürüm - Sunucudan Sunucuya Güvenli Kayıt)

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios'); // YENİ: HTTP istekleri için

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- GÜVENLİK VE API AYARLARI ---
const ADMIN_SECRET_KEY = "gizli-anahtar";
const API_SECRET_KEY = 'BurayaCokGuvenliBirSifreYazin_12345_abcde'; // YENİ: PHP dosyasındakiyle aynı olmalı
const PHP_API_URL = 'https://bet.nesligida.com/rulet/api_update_balance.php'; // YENİ: Sitenizin tam URL'si

// --- OYUN AYARLARI ---
const BET_TIME = 45000;
const SPIN_TIME = 8000;
const RESULT_TIME = 7000;
const PAYOUT_RATE = 36;

// --- OYUN DURUMLARI ---
let gameState = 'IDLE';
let currentBets = {};
let playerData = {}; // Artık userId de burada tutulacak
let gameLoopTimeout;

// YENİ: Sunucudan PHP'ye bakiye güncelleme isteği gönderen fonksiyon
async function updateUserBalanceInDB(userId, newBalance) {
    try {
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
        // Hata detaylarını görmek isterseniz:
        // if (error.response) console.error('Hata Detayı:', error.response.data);
    }
}


io.on('connection', (socket) => {
    console.log(`Bir kullanıcı bağlandı: ${socket.id}`);
    const initialData = socket.handshake.auth;

    // YENİ: Artık oyuncunun veritabanı ID'sini de saklıyoruz. Bu çok önemli.
    if (!initialData.userId) {
        console.log(`Bağlantı reddedildi: Kullanıcı ID'si yok. Socket ID: ${socket.id}`);
        return socket.disconnect();
    }
    
    playerData[socket.id] = {
        userId: initialData.userId, // Kullanıcının veritabanındaki ID'si
        balance: initialData.balance !== undefined ? parseFloat(initialData.balance) : 1000,
        name: initialData.name || 'Oyuncu'
    };
    
    socket.emit('update_balance', { newBalance: playerData[socket.id].balance });

    socket.on('place_bet', (data) => {
        // ... bahis alma mantığı aynı, değişiklik yok ...
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
        // ... bahis iptali mantığı aynı, değişiklik yok ...
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
        // ... admin mantığı aynı, değişiklik yok ...
    });

    socket.on('disconnect', () => {
        console.log(`Bir kullanıcı ayrıldı: ${socket.id}`);
        // YENİ: Oyuncu verisini hemen silmiyoruz!
        // Oyuncu tur ortasında ayrılırsa, bahisleri ve verileri turun sonuna kadar saklanır.
        // Temizlik işlemi startNewRound() fonksiyonunda yapılır.
    });
});

function startNewRound() {
    gameState = 'BETTING';
    // YENİ: Önceki turdan kalan bahisleri ve bağlantısı kopmuş oyuncu verilerini temizle
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
    // ... startSpin mantığı aynı, değişiklik yok ...
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
    
    // YENİ: Oyuncu bağlı olsun ya da olmasın, bahsi olan herkesin sonucunu işle.
    for (const socketId in currentBets) {
        // Oyuncunun verisi hala playerData'da mevcut mu kontrol et (tur ortasında girmemişse olmaz)
        if (!playerData[socketId]) continue;

        let totalWinnings = 0;
        const playerBets = currentBets[socketId];
        
        playerBets.forEach(bet => {
            if (parseInt(bet.value) === winningNumber) {
                totalWinnings += bet.amount * PAYOUT_RATE;
            }
        });

        const player = playerData[socketId];
        player.balance += totalWinnings; // Nihai bakiyeyi hesapla

        // YENİ: Hesaplanan nihai bakiyeyi veritabanına kaydetmesi için API isteği gönder.
        updateUserBalanceInDB(player.userId, player.balance);
        
        // Oyuncu hala bağlıysa, onu bilgilendir.
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
