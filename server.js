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
let gameState = 'IDLE'; 
let currentBets = {}; 
// YENİ: Oyuncuların bakiyelerini sunucuda tutalım
let playerData = {}; 

// --- BAĞLANTI YÖNETİMİ ---
io.on('connection', (socket) => {
    console.log(`Bir kullanıcı bağlandı: ${socket.id}`);

    // YENİ: Yeni bağlanan kullanıcıya başlangıç bakiyesi verelim
    if (!playerData[socket.id]) {
        playerData[socket.id] = { balance: 1000 }; // Başlangıç FunnyCoin'i
    }
    // Kullanıcıya mevcut bakiyesini gönderelim
    socket.emit('update_balance', { newBalance: playerData[socket.id].balance });


    socket.on('place_bet', (data) => {
        if (gameState !== 'BETTING') {
            return socket.emit('bet_failed', { message: 'Bahisler şu an kapalı.' });
        }
        
        const player = playerData[socket.id];
        const betAmount = parseInt(data.amount);

        // YENİ: Bakiye kontrolü
        if (player.balance < betAmount) {
            return socket.emit('bet_failed', { message: 'Yetersiz bakiye!' });
        }
        
        // Bakiyeden düş ve bahsi kaydet
        player.balance -= betAmount;
        
        if (!currentBets[socket.id]) {
            currentBets[socket.id] = [];
        }
        currentBets[socket.id].push({ value: data.value, amount: betAmount });

        // Oyuncuya güncel bakiyesini anında bildir
        socket.emit('update_balance', { newBalance: player.balance });
        socket.emit('bet_successful', { message: 'Bahsiniz kabul edildi.' });
        console.log(`Kullanıcı ${socket.id}, ${data.amount} FNC ile ${data.value} sayısına bahis yaptı. Kalan bakiye: ${player.balance}`);
    });

    socket.on('admin_command', (data) => {
        if (data.secret !== ADMIN_SECRET_KEY) {
            console.log("Geçersiz admin anahtarı ile komut denemesi!");
            return;
        }

        console.log(`Admin komutu alındı: ${data.command}`);
        socket.emit('admin_feedback', `Komut alındı: ${data.command}`);

        switch (data.command) {
            case 'start_round':
                gameState = 'BETTING';
                currentBets = {}; 
                io.emit('new_round', { countdown: 20 }); // Örnek süre
                console.log("Yeni tur başlatıldı, bahisler açık.");
                break;
            
            case 'close_bets':
                gameState = 'SPINNING';
                io.emit('bets_closed');
                console.log("Bahisler kapatıldı.");
                break;

            case 'spin_wheel':
                if (gameState !== 'SPINNING') {
                    socket.emit('admin_feedback', 'Önce bahisleri kapatmalısınız!');
                    return;
                }
                
                const winningNumber = (data.forcedNumber !== null && data.forcedNumber >= 0 && data.forcedNumber <= 36)
                    ? data.forcedNumber
                    : Math.floor(Math.random() * 37);

                console.log(`Kazanan sayı belirlendi: ${winningNumber}`);
                
                // Animasyon için kazanan sayıyı tüm istemcilere gönder
                io.emit('spin_result', { number: winningNumber });

                // Kazançları hesapla ve sonuçları dağıt
                calculateAndDistributeWinnings(winningNumber);
                
                gameState = 'IDLE'; 
                console.log("Tur bitti. Yeni tur için komut bekleniyor.");
                break;
        }
    });

    socket.on('disconnect', () => {
        console.log(`Bir kullanıcı ayrıldı: ${socket.id}`);
        // İsteğe bağlı: Oyuncu verisini sil. Eğer tekrar bağlandığında kaldığı yerden devam etmesini istemiyorsanız.
        // delete playerData[socket.id];
    });
});

// YENİ ve GÜNCELLENMİŞ FONKSİYON
function calculateAndDistributeWinnings(winningNumber) {
    console.log(`${winningNumber} için kazananlar hesaplanıyor...`);
    const PAYOUT_RATE = 36; // 1'e 36 öder

    // Bahis yapan her oyuncu için işlem yap
    for (const socketId in currentBets) {
        let totalWinnings = 0;
        let totalBetAmount = 0;
        const playerBets = currentBets[socketId];
        
        playerBets.forEach(bet => {
            totalBetAmount += bet.amount;
            if (bet.value === winningNumber) {
                totalWinnings += bet.amount * PAYOUT_RATE;
            }
        });

        const player = playerData[socketId];
        let resultMessage = "";

        if (totalWinnings > 0) {
            player.balance += totalWinnings; // Kazancı bakiyeye ekle
            resultMessage = `Tebrikler! ${winningNumber} sayısına yaptığınız bahisten ${totalWinnings} FunnyCoin kazandınız!`;
        } else {
            resultMessage = `Bu tur kazanamadınız. Kazanan sayı: ${winningNumber}.`;
        }

        // Sonucu sadece ilgili oyuncuya gönder
        const playerSocket = io.sockets.sockets.get(socketId);
        if (playerSocket) {
             playerSocket.emit('round_result', { 
                message: resultMessage,
                newBalance: player.balance 
            });
        }
    }
}


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor.`);
    console.log("Oyun admin panelinden manuel olarak kontrol edilecek.");
});
