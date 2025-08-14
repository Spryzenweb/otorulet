// server.js (Tam Sürüm)

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const ADMIN_SECRET_KEY = "gizli-anahtar";
let gameState = 'IDLE';
let currentBets = {};
let playerData = {};

io.on('connection', (socket) => {
    console.log(`Bir kullanıcı bağlandı: ${socket.id}`);

    const initialData = socket.handshake.auth;
    
    if (!playerData[socket.id]) {
        playerData[socket.id] = {
            balance: initialData.balance !== undefined ? parseFloat(initialData.balance) : 1000,
            name: initialData.name || 'Oyuncu'
        };
    }
    
    socket.emit('update_balance', { newBalance: playerData[socket.id].balance });

    socket.on('place_bet', (data) => {
        if (gameState !== 'BETTING') {
            return socket.emit('bet_failed', { message: 'Bahisler şu an kapalı.' });
        }
        
        const player = playerData[socket.id];
        const betAmount = parseFloat(data.amount);

        if (player.balance < betAmount) {
            return socket.emit('bet_failed', { message: 'Yetersiz bakiye!' });
        }
        
        player.balance -= betAmount;
        
        if (!currentBets[socket.id]) {
            currentBets[socket.id] = [];
        }
        currentBets[socket.id].push({ value: data.value, amount: betAmount });

        socket.emit('update_balance', { newBalance: player.balance });
        socket.emit('bet_successful', { message: 'Bahsiniz kabul edildi.' });
        console.log(`Kullanıcı ${player.name} (${socket.id}), ${data.amount} ile ${data.value} sayısına bahis yaptı. Kalan bakiye: ${player.balance}`);
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
                io.emit('new_round', { countdown: 20 });
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
                
                io.emit('spin_result', { number: winningNumber });

                setTimeout(() => {
                    calculateAndDistributeWinnings(winningNumber);
                    gameState = 'IDLE';
                    console.log("Tur bitti. Yeni tur için komut bekleniyor.");
                }, 9000); // Animasyonun bitmesi için zaman tanır (8sn çark + 1sn top)
                break;
        }
    });

    socket.on('disconnect', () => {
        console.log(`Bir kullanıcı ayrıldı: ${socket.id}`);
        delete playerData[socket.id];
        delete currentBets[socket.id];
    });
});

function calculateAndDistributeWinnings(winningNumber) {
    console.log(`${winningNumber} için kazananlar hesaplanıyor...`);
    const PAYOUT_RATE = 36;

    for (const socketId in currentBets) {
        let totalWinnings = 0;
        const playerBets = currentBets[socketId];
        
        playerBets.forEach(bet => {
            if (bet.value === winningNumber) {
                totalWinnings += bet.amount * PAYOUT_RATE;
            }
        });

        // Oyuncunun hala bağlı ve verisinin mevcut olduğundan emin ol
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
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor.`);
    console.log("Oyun admin panelinden manuel olarak kontrol edilecek.");
});
