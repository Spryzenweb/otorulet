const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

// CORS ayarları
app.use(cors({
    origin: '*',
    credentials: true
}));

// Hosting API'sine proxy
app.use('/api', createProxyMiddleware({
    target: 'https://your-hosting-domain.com', // Hosting adresinizi yazın
    changeOrigin: true,
    pathRewrite: {
        '^/api': '/backend/api'
    },
    onError: (err, req, res) => {
        console.error('Proxy error:', err);
        res.status(500).json({ error: 'Proxy error', message: err.message });
    }
}));

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'Proxy server running', timestamp: new Date() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🔄 Proxy server running on port ${PORT}`);
});

module.exports = app;
