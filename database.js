const mysql = require('mysql2/promise');
require('dotenv').config({ path: './config.env' });

class Database {
    constructor() {
        this.pool = mysql.createPool({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'nesligi_db',
            password: process.env.DB_PASSWORD || '157982bt',
            database: process.env.DB_NAME || 'nesligi_db',
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            charset: 'utf8mb4'
        });
        
        console.log('📊 Database pool created');
    }

    async getConnection() {
        try {
            const connection = await this.pool.getConnection();
            return connection;
        } catch (error) {
            console.error('Database connection error:', error);
            throw error;
        }
    }

    async query(sql, params = []) {
        const connection = await this.getConnection();
        try {
            const [rows] = await connection.execute(sql, params);
            return rows;
        } finally {
            connection.release();
        }
    }

    async transaction(callback) {
        const connection = await this.getConnection();
        try {
            await connection.beginTransaction();
            const result = await callback(connection);
            await connection.commit();
            return result;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // Game-specific methods
    async createGameSession() {
        const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        await this.query(
            'INSERT INTO game_sessions (session_id, game_type, start_time, status) VALUES (?, ?, NOW(), ?)',
            [sessionId, 'roulette', 'active']
        );
        
        return sessionId;
    }

    async createGameRound(sessionId, roundNumber) {
        const result = await this.query(
            'INSERT INTO game_rounds (session_id, round_number, start_time) VALUES ((SELECT id FROM game_sessions WHERE session_id = ?), ?, NOW())',
            [sessionId, roundNumber]
        );
        
        return result.insertId;
    }

    async saveBet(userId, roundId, betType, betValue, betAmount, payoutMultiplier) {
        return await this.query(
            'INSERT INTO bets (user_id, round_id, bet_type, bet_value, bet_amount, payout_multiplier, placed_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
            [userId, roundId, betType, betValue, betAmount, payoutMultiplier]
        );
    }

    async finishRound(roundId, winningNumber, totalBets, totalPayouts) {
        return await this.transaction(async (connection) => {
            // Update round with results
            await connection.execute(
                'UPDATE game_rounds SET winning_number = ?, end_time = NOW(), total_bets = ?, total_payouts = ?, house_profit = ? WHERE id = ?',
                [winningNumber, totalBets, totalPayouts, totalBets - totalPayouts, roundId]
            );

            // Update winning bets
            const [winningBets] = await connection.execute(
                'SELECT id, user_id, bet_amount, payout_multiplier FROM bets WHERE round_id = ? AND (' +
                'bet_value = ? OR ' + // Exact number
                '(bet_type = "red" AND ? IN (1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36)) OR ' +
                '(bet_type = "black" AND ? IN (2,4,6,8,10,11,13,15,17,20,22,24,26,28,29,31,33,35)) OR ' +
                '(bet_type = "even" AND ? > 0 AND ? % 2 = 0) OR ' +
                '(bet_type = "odd" AND ? % 2 = 1) OR ' +
                '(bet_type = "low" AND ? >= 1 AND ? <= 18) OR ' +
                '(bet_type = "high" AND ? >= 19 AND ? <= 36))',
                [roundId, winningNumber, winningNumber, winningNumber, winningNumber, winningNumber, winningNumber, winningNumber, winningNumber, winningNumber, winningNumber]
            );

            // Process each winning bet
            for (const bet of winningBets) {
                const payoutAmount = bet.bet_amount * bet.payout_multiplier;
                
                // Mark bet as winner
                await connection.execute(
                    'UPDATE bets SET is_winner = 1, payout_amount = ? WHERE id = ?',
                    [payoutAmount, bet.id]
                );

                // Update user balance
                await connection.execute(
                    'UPDATE users SET balance = balance + ? WHERE id = ?',
                    [payoutAmount, bet.user_id]
                );

                // Log transaction
                const [userBalance] = await connection.execute(
                    'SELECT balance FROM users WHERE id = ?',
                    [bet.user_id]
                );

                await connection.execute(
                    'INSERT INTO balance_transactions (user_id, transaction_type, amount, balance_before, balance_after, reference_id, description) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [
                        bet.user_id,
                        'win',
                        payoutAmount,
                        userBalance[0].balance - payoutAmount,
                        userBalance[0].balance,
                        bet.id,
                        `Rulet kazancı - Tur ${winningNumber}`
                    ]
                );
            }

            return winningBets;
        });
    }

    async getUserBalance(userId) {
        const result = await this.query('SELECT balance FROM users WHERE id = ?', [userId]);
        return result[0]?.balance || 0;
    }

    async updateUserBalance(userId, newBalance, transactionType = 'game_result', description = null, referenceId = null) {
        return await this.transaction(async (connection) => {
            // Get current balance
            const [currentBalance] = await connection.execute('SELECT balance FROM users WHERE id = ?', [userId]);
            const oldBalance = currentBalance[0]?.balance || 0;

            // Update balance
            await connection.execute('UPDATE users SET balance = ? WHERE id = ?', [newBalance, userId]);

            // Log transaction
            await connection.execute(
                'INSERT INTO balance_transactions (user_id, transaction_type, amount, balance_before, balance_after, reference_id, description) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [userId, transactionType, newBalance - oldBalance, oldBalance, newBalance, referenceId, description]
            );

            return true;
        });
    }

    async logAction(userId, action, details = null, ipAddress = null) {
        try {
            await this.query(
                'INSERT INTO system_logs (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)',
                [userId, action, details ? JSON.stringify(details) : null, ipAddress]
            );
        } catch (error) {
            console.error('Logging error:', error);
        }
    }

    async close() {
        await this.pool.end();
        console.log('📊 Database pool closed');
    }
}

module.exports = Database;
