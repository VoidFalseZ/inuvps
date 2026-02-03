// routes/chat.js - Chat endpoints

const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const config = require('../config');
const chatService = require('../services/chatService');

// Chat upload configuration
const chatStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, chatService.CHAT_UPLOADS_DIR);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'chat-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const uploadChat = multer({
    storage: chatStorage,
    limits: { fileSize: config.CHAT.UPLOAD_SIZE_LIMIT }
});

// Chat image upload endpoint
router.post('/upload', uploadChat.single('image'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No image file provided' });
    }
    const imageUrl = `/chat_uploads/${req.file.filename}`;
    res.json({ url: imageUrl });
});

module.exports = router;
