// server.js (Tam Sürüm - Otomatik Döngü ve Bahis İptali)

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const ADMIN_SECRET_KEY = "gizli-anahtar";

// --- OYUN AYARLARI ---
const BET_TIME = 45000;       // Bahisler için 45 saniye
const SPIN_TIME = 8000;       // Çarkın dönme animasyonu süresi
const RESULT_TIME = 7000;     // Sonuçları gösterme ve yeni tura geçme arası bekleme süresi
const PAYOUT_RATE = 36;       // Kazanç oranı

// --- OYUN DURUMLARI ---
let gameState = 'IDLE';       // IDLE, BETTING, SPINNING
let currentBets = {};         // { socketId: [{ betId, value, amount }, ...], ... }
let playerData = {};          // { socketId: { balance, name }, ... }
let gameLoopTimeout;          // Oyun döngüsünün zamanlayıcısı

io.on('connection', (socket) => {
    console.log(`Bir kullanıcı bağlandı: ${socket.id}`);
    const initialData = socket.handshake.auth;
    
    // Oyuncu verisini oluştur
    if (!playerData[socket.id]) {
        playerData[socket.id] = {
            balance: initialData.balance !== undefined ? parseFloat(initialData.balance) : 1000,
            name: initialData.name || 'Oyuncu'
        };
    }
    
    // Mevcut oyun durumu ve kalan süre hakkında yeni bağlanan oyuncuyu bilgilendir
    socket.emit('update_balance', { newBalance: playerData[socket.id].balance });
    
    // --- BAHİS ALMA ---
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
        
        const betId = Date.now() + "_" + socket.id; // Benzersiz bahis ID'si
        const newBet = { betId: betId, value: data.value, amount: betAmount };
        currentBets[socket.id].push(newBet);

        socket.emit('update_balance', { newBalance: player.balance });
        socket.emit('bet_successful', newBet); // Bahis detaylarını geri gönder
        console.log(`Kullanıcı ${player.name} (${socket.id}), ${data.amount}₺ ile ${data.value} sayısına bahis yaptı. Kalan bakiye: ${player.balance}`);
    });
    
    // --- YENİ: BAHİS İPTALİ ---
    socket.on('cancel_bet', (data) => {
        if (gameState !== 'BETTING') return; // Sadece bahis zamanı iptal edilebilir

        const player = playerData[socket.id];
        const bets = currentBets[socket.id];

        if (!player || !bets) return;

        const betIndex = bets.findIndex(b => b.betId === data.betId);
        if (betIndex === -1) return; // Bahis bulunamadı

        const betToCancel = bets[betIndex];
        player.balance += betToCancel.amount; // Parayı iade et
        bets.splice(betIndex, 1); // Bahsi listeden sil

        socket.emit('update_balance', { newBalance: player.balance });
        socket.emit('bet_cancelled_ok', { betId: data.betId, message: 'Bahis iptal edildi.' });
        console.log(`Kullanıcı ${player.name} (${socket.id}), ${data.betId} numaralı bahsini iptal etti.`);
    });

    // --- ADMİN KOMUTLARI ---
    socket.on('admin_command', (data) => {
        if (data.secret !== ADMIN_SECRET_KEY) {
            console.log("Geçersiz admin anahtarı ile komut denemesi!");
            return;
        }

        console.log(`Admin komutu alındı: ${data.command}`);
        socket.emit('admin_feedback', `Komut alındı: ${data.command}`);

        if (data.command === 'force_spin') {
            if (gameState === 'BETTING') {
                console.log("Admin tarafından tur anında sonlandırılıyor!");
                clearTimeout(gameLoopTimeout); // Normal döngüyü iptal et
                startSpin(data.forcedNumber); // Döndürme aşamasını hemen başlat
            } else {
                socket.emit('admin_feedback', 'Bu komut sadece bahisler açıkken kullanılabilir.');
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`Bir kullanıcı ayrıldı: ${socket.id}`);
        // Oyuncu verilerini ve bahislerini temizle
        delete playerData[socket.id];
        delete currentBets[socket.id];
    });
});

// --- OTOMATİK OYUN DÖNGÜSÜ ---

function startNewRound() {
    gameState = 'BETTING';
    currentBets = {}; // Her tur başında bahisleri sıfırla
    const countdown = BET_TIME / 1000;
    io.emit('new_round', { countdown: countdown });
    console.log(`Yeni tur başlatıldı. Bahisler ${countdown} saniye boyunca açık.`);
    
    // Belirtilen süre sonunda döndürme aşamasına geç
    gameLoopTimeout = setTimeout(() => startSpin(null), BET_TIME);
}

function startSpin(forcedNumber = null) {
    gameState = 'SPINNING';
    io.emit('bets_closed');
    console.log("Bahisler kapatıldı. Çark dönüyor...");

    const winningNumber = (forcedNumber !== null && forcedNumber >= 0 && forcedNumber <= 36)
        ? forcedNumber
        : Math.floor(Math.random() * 37);

    console.log(`Kazanan sayı belirlendi: ${winningNumber}`);
    io.emit('spin_result', { number: winningNumber });

    // Animasyonun bitmesini bekle, sonra sonuçları hesapla
    setTimeout(() => calculateAndDistributeWinnings(winningNumber), SPIN_TIME);
}

function calculateAndDistributeWinnings(winningNumber) {
    console.log(`${winningNumber} için kazananlar hesaplanıyor...`);
    
    for (const socketId in currentBets) {
        let totalWinnings = 0;
        const playerBets = currentBets[socketId];
        
        playerBets.forEach(bet => {
            if (bet.value === winningNumber) {
                totalWinnings += bet.amount * PAYOUT_RATE;
            }
        });

        if (playerData[socketId]) {
            const player = playerData[socketId];
            let resultMessage = "";

            if (totalWinnings > 0) {
                player.balance += totalWinnings;
                resultMessage = `Tebrikler! ${winningNumber} sayısına yaptığınız bahisten ${totalWinnings.toLocaleString('tr-TR', {minimumFractionDigits: 2})} ₺ kazandınız!`;
            } else {
                resultMessage = `Bu tur kazanamadınız. Kazanan sayı: ${winningNumber}.`;
            }

            const playerSocket = io.sockets.sockets.get(socketId);
            if (playerSocket) {
                 playerSocket.emit('round_result', { 
                    message: resultMessage,
                    newBalance: player.balance 
                });
            }
        }
    }

    // Sonuçların gösterilmesi için bir süre bekle ve yeni turu başlat
    console.log("Tur bitti. Yeni tur için bekleniyor...");
    gameState = 'IDLE';
    gameLoopTimeout = setTimeout(startNewRound, RESULT_TIME);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor.`);
    console.log("Oyun otomatik döngüde başlayacak...");
    startNewRound(); // Sunucu başlar başlamaz ilk turu başlat
});
