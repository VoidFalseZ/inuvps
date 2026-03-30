// src/routes/chatRoutes.js — Chat upload routes

'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const config = require('../config');
const chatService = require('../services/chatService');
const chatCtrl = require('../controllers/chatController');

// Multer config for chat image uploads
const chatStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, chatService.CHAT_UPLOADS_DIR),
    filename: (req, file, cb) => {
        const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
        cb(null, `chat-${uniqueSuffix}${path.extname(file.originalname)}`);
    },
});

const uploadChat = multer({
    storage: chatStorage,
    limits: { fileSize: config.CHAT.UPLOAD_SIZE_LIMIT, files: 1 },
});

router.post('/upload', uploadChat.single('image'), chatCtrl.uploadImage);

module.exports = router;
