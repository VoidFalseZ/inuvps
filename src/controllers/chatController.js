// src/controllers/chatController.js — Chat upload handler

'use strict';

/**
 * POST /api/chat/upload — Upload a chat image
 */
function uploadImage(req, res) {
    if (!req.file) {
        return res.status(400).json({ error: 'No image file provided' });
    }
    const imageUrl = `/chat_uploads/${req.file.filename}`;
    res.json({ url: imageUrl });
}

module.exports = { uploadImage };
