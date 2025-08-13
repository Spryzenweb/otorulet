// server.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

const ADMIN_SECRET_KEY = "gizli-anahtar";
const ROUND_DURATION = 20; // Saniye cinsinden bahis süresi

let gameState = 'IDLE'; // IDLE, BETTING, SPINNING
let currentBets = {}; 
let playerData = {}; // { socketId: { name: 'Oyuncu', balance: 1000 } }
let countdownTimer;
let adminSocketId = null; // Admini takip etmek için

// --- BAĞLANTI YÖNETİMİ ---
io.on('connection', (socket) => {
    const playerName = socket.handshake.auth.name || 'Misafir' + Math.floor(Math.random() * 1000);
    console.log(`Bir kullanıcı bağlandı: ${playerName} (${socket.id})`);

    // Yeni bağlanan kullanıcıya başlangıç verilerini ata
    playerData[socket.id] = { 
        name: playerName,
        balance: 1000 // Başlangıç FunnyCoin'i
    };
    
    // Kullanıcıya mevcut bakiyesini gönder
    socket.emit('update_balance', { newBalance: playerData[socket.id].balance });

    // BAHİS YERLEŞTİRME
    socket.on('place_bet', (data) => {
        if (gameState !== 'BETTING') {
            return socket.emit('bet_failed', { message: 'Bahisler şu an kapalı.' });
        }
        
        const player = playerData[socket.id];
        const betAmount = parseInt(data.amount);

        if (!player) return; // Oyuncu verisi yoksa işlemi durdur

        if (player.balance < betAmount) {
            return socket.emit('bet_failed', { message: 'Yetersiz bakiye!' });
        }
        
        player.balance -= betAmount;
        
        if (!currentBets[socket.id]) {
            currentBets[socket.id] = [];
        }
        currentBets[socket.id].push({ value: data.value, amount: betAmount });

        socket.emit('update_balance', { newBalance: player.balance });
        socket.emit('bet_successful');
        console.log(`BAHİS: ${player.name}, ${betAmount} FNC ile ${data.value} sayısına oynadı. Kalan bakiye: ${player.balance}`);

        // Admin'e anlık bahis bilgisini gönder
        if (adminSocketId) {
            io.to(adminSocketId).emit('admin_new_bet', {
                message: `${player.name}, ${betAmount} FNC ile ${data.value} sayısına bahis yaptı.`
            });
        }
    });

    // ADMİN KOMUTLARI
    socket.on('admin_command', (data) => {
        if (data.secret !== ADMIN_SECRET_KEY) {
            return console.log("Geçersiz admin anahtarı ile komut denemesi!");
        }

        adminSocketId = socket.id; // Komut gönderen kişiyi admin olarak kaydet
        console.log(`Admin komutu alındı: ${data.command}`);
        socket.emit('admin_feedback', `Komut başarıyla çalıştırıldı: ${data.command}`);

        switch (data.command) {
            case 'start_round':
                if (gameState === 'IDLE') {
                    startNewRound();
                } else {
                    socket.emit('admin_feedback', 'Zaten devam eden bir tur var.');
                }
                break;
            
            case 'spin_now': // Manuel spin için
                 if (gameState === 'BETTING') {
                    clearTimeout(countdownTimer); // Otomatik sayacı iptal et
                    startSpin(data.forcedNumber);
                } else {
                    socket.emit('admin_feedback', 'Bu komut sadece bahisler açıkken kullanılabilir.');
                }
                break;
        }
    });

    socket.on('disconnect', () => {
        const player = playerData[socket.id];
        if (player) {
            console.log(`Bir kullanıcı ayrıldı: ${player.name} (${socket.id})`);
            delete playerData[socket.id];
        }
        if (socket.id === adminSocketId) {
            console.log("Admin bağlantısı kesildi.");
            adminSocketId = null;
        }
    });
});

// --- OYUN AKIŞI FONKSİYONLARI ---

function startNewRound() {
    gameState = 'BETTING';
    currentBets = {}; 
    io.emit('new_round', { countdown: ROUND_DURATION });
    console.log(`Yeni tur başlatıldı. Bahisler ${ROUND_DURATION} saniye açık.`);
    
    // Admin paneline yeni turun başladığını ve bahis listesini temizlemesi gerektiğini bildir
    if (adminSocketId) {
        io.to(adminSocketId).emit('admin_clear_bets');
    }

    // Süre bitince çarkı otomatik döndür
    countdownTimer = setTimeout(() => {
        startSpin(null); // Rastgele bir sayı ile döndür
    }, ROUND_DURATION * 1000);
}

function startSpin(forcedNumber) {
    gameState = 'SPINNING';
    io.emit('bets_closed');
    console.log("Bahisler kapatıldı. Çark dönüyor...");

    // Çarkın dönmesi için kısa bir bekleme süresi
    setTimeout(() => {
        const winningNumber = (forcedNumber !== null && forcedNumber >= 0 && forcedNumber <= 36)
            ? forcedNumber
            : Math.floor(Math.random() * 37);

        console.log(`Kazanan sayı belirlendi: ${winningNumber}`);
        io.emit('spin_result', { number: winningNumber });

        // Sonuçları hesapla ve dağıt
        setTimeout(() => {
            calculateAndDistributeWinnings(winningNumber);
            gameState = 'IDLE';
            console.log("Tur bitti. Yeni tur için admin komutu bekleniyor.");
        }, 9000); // Animasyonun bitmesini bekle

    }, 2000); // Bahisler kapandıktan 2 saniye sonra döndür
}


function calculateAndDistributeWinnings(winningNumber) {
    console.log(`${winningNumber} için kazananlar hesaplanıyor...`);
    const PAYOUT_RATE = 36;

    for (const socketId in currentBets) {
        const player = playerData[socketId];
        // Oyuncu hala bağlı mı diye kontrol et
        if (!player) continue;

        let totalWinnings = 0;
        let hasWon = false;
        
        currentBets[socketId].forEach(bet => {
            if (bet.value === winningNumber) {
                totalWinnings += bet.amount * PAYOUT_RATE;
                hasWon = true;
            }
        });

        let resultMessage = "";

        if (hasWon) {
            player.balance += totalWinnings;
            resultMessage = `Tebrikler! ${winningNumber} sayısından ${totalWinnings} FunnyCoin kazandınız!`;
        } else {
            resultMessage = `Bu tur kazanamadınız. Kazanan sayı: ${winningNumber}.`;
        }

        const playerSocket = io.sockets.sockets.get(socketId);
        if (playerSocket) {
             playerSocket.emit('round_result', { 
                message: resultMessage,
                newBalance: player.balance,
                win: hasWon
            });
        }
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor.`);
    console.log("Oyun admin panelinden kontrol edilecek.");
});
