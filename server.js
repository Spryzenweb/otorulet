// server.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Her yerden erişime izin ver (geliştirme için)
        methods: ["GET", "POST"]
    }
});

// --- YENİ EKLENENLER ---
const ADMIN_SECRET_KEY = "gizli-anahtar"; // admin.html'deki ile aynı olmalı
let gameState = 'IDLE'; // Oyunun durumunu tutar: IDLE, BETTING, SPINNING
let currentBets = {}; // Aktif bahisleri tutan obje
// ----------------------

// ******** ESKİ OTOMATİK DÖNGÜYÜ SİLİN VEYA YORUM SATIRI YAPIN ********
/*
const GAME_INTERVAL = 35000;
const BETTING_TIME = 20000;

function startGameLoop() {
  setInterval(() => {
     // BU KISMIN TAMAMI ARTIK KULLANILMAYACAK
  }, GAME_INTERVAL);
}
*/
// ********************************************************************


// --- BAĞLANTI YÖNETİMİ ---
io.on('connection', (socket) => {
    console.log(`Bir kullanıcı bağlandı: ${socket.id}`);

    // Oyuncunun bahis yapma isteğini dinle
    socket.on('place_bet', (data) => {
        if (gameState !== 'BETTING') {
            return socket.emit('bet_failed', { message: 'Bahisler şu an kapalı.' });
        }
        // Burada bakiye kontrolü vs. yapılmalı
        console.log(`Kullanıcı ${socket.id}, ${data.amount} FNC ile ${data.value} sayısına bahis yaptı.`);
        
        // Bahsi kaydet (basit haliyle)
        if (!currentBets[socket.id]) {
            currentBets[socket.id] = [];
        }
        currentBets[socket.id].push(data);

        socket.emit('bet_successful', { message: 'Bahsiniz kabul edildi.' });
    });


    // --- YENİ: ADMİN KOMUTLARINI DİNLE ---
    socket.on('admin_command', (data) => {
        // 1. Güvenlik Kontrolü
        if (data.secret !== ADMIN_SECRET_KEY) {
            console.log("Geçersiz admin anahtarı ile komut denemesi!");
            return;
        }

        console.log(`Admin komutu alındı: ${data.command}`);
        socket.emit('admin_feedback', `Komut alındı: ${data.command}`);

        // 2. Komutu İşle
        switch (data.command) {
            case 'start_round':
                gameState = 'BETTING';
                currentBets = {}; // Eski bahisleri temizle
                io.emit('new_round', { countdown: 999 }); // Süre göstermelik
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
                
                // Admin bir sayı belirttiyse onu kullan, belirtmediyse rastgele seç
                const winningNumber = (data.forcedNumber !== null && data.forcedNumber >= 0 && data.forcedNumber <= 36)
                    ? data.forcedNumber
                    : Math.floor(Math.random() * 37);

                console.log(`Kazanan sayı belirlendi: ${winningNumber}`);
                io.emit('spin_result', { number: winningNumber });

                // Kazançları hesapla (Bu fonksiyonu ayrıca yazmanız gerekir)
                calculateWinnings(winningNumber);
                
                gameState = 'IDLE'; // Turu bitir
                console.log("Tur bitti. Yeni tur için komut bekleniyor.");
                break;
        }
    });

    socket.on('disconnect', () => {
        console.log(`Bir kullanıcı ayrıldı: ${socket.id}`);
    });
});

function calculateWinnings(winningNumber) {
    console.log(`${winningNumber} için kazananlar hesaplanıyor...`);
    // Bu fonksiyon, currentBets'teki her bahsi kontrol eder,
    // kazananların veritabanındaki bakiyelerini günceller
    // ve io.to(socketId).emit('update_balance', ...) ile oyunculara bildirir.
}


const PORT = process.env.PORT || 3000; 
server.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor.`);
    console.log("Oyun admin panelinden manuel olarak kontrol edilecek.");
});
