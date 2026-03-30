// src/services/chatService.js — Chat history management (async I/O)

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../config');
const { createLogger } = require('../utils/logger');
const { DIRS, DATA_FILES } = require('../constants');

const log = createLogger('Chat');

const CACHE_DIR = path.resolve(__dirname, '..', '..', DIRS.CACHE);
const CHAT_HISTORY_FILE = path.join(CACHE_DIR, DATA_FILES.CHAT_HISTORY);
const CHAT_UPLOADS_DIR = path.resolve(__dirname, '..', '..', DIRS.CHAT_UPLOADS);

// Ensure directories exist
fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(CHAT_UPLOADS_DIR, { recursive: true });

// ─── State ───────────────────────────────────────────────────────────────────

let chatHistory = [];
let ioInstance = null;
let saveTimer = null;
const SAVE_DEBOUNCE_MS = 1000;

// ─── Persistence ─────────────────────────────────────────────────────────────

function loadHistory() {
    try {
        if (fs.existsSync(CHAT_HISTORY_FILE)) {
            chatHistory = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf8'));
            const oneDayAgo = Date.now() - config.CHAT.MAX_AGE_MS;
            chatHistory = chatHistory.filter(msg => new Date(msg.timestamp).getTime() > oneDayAgo);
            log.info(`Loaded ${chatHistory.length} messages from history`);
        }
    } catch (error) {
        log.error('Failed to load history:', error.message);
        chatHistory = [];
    }
}

/**
 * Save chat history asynchronously (debounced).
 */
function saveHistory() {
    if (saveTimer) clearTimeout(saveTimer);

    saveTimer = setTimeout(async () => {
        try {
            await fsp.mkdir(CACHE_DIR, { recursive: true });
            await fsp.writeFile(CHAT_HISTORY_FILE, JSON.stringify(chatHistory, null, 2), 'utf8');
            log.debug('History saved to disk');
        } catch (error) {
            log.error('Failed to save history:', error.message);
        }
    }, SAVE_DEBOUNCE_MS);
}

/**
 * Flush any pending writes immediately.
 */
async function flush() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        try {
            await fsp.writeFile(CHAT_HISTORY_FILE, JSON.stringify(chatHistory, null, 2), 'utf8');
            log.info('History flushed to disk');
        } catch (error) {
            log.error('Flush failed:', error.message);
        }
    }
}

// ─── Chat Operations ─────────────────────────────────────────────────────────

/**
 * Add a message and persist.
 * @param {Object} msg
 * @returns {Object}
 */
function addMessage(msg) {
    if (!msg.timestamp) msg.timestamp = new Date().toISOString();

    chatHistory.push(msg);

    // Prune old messages
    const oneDayAgo = Date.now() - config.CHAT.MAX_AGE_MS;
    if (chatHistory.length > 0 && new Date(chatHistory[0].timestamp).getTime() < oneDayAgo) {
        chatHistory = chatHistory.filter(m => new Date(m.timestamp).getTime() > oneDayAgo);
    }

    saveHistory();
    return msg;
}

function getHistory() {
    return chatHistory;
}

function pruneOldMessages() {
    const oneDayAgo = Date.now() - config.CHAT.MAX_AGE_MS;
    const hadOld = chatHistory.some(m => new Date(m.timestamp).getTime() < oneDayAgo);

    if (hadOld) {
        chatHistory = chatHistory.filter(m => new Date(m.timestamp).getTime() > oneDayAgo);
        saveHistory();
        log.info('Pruned old messages');
        return true;
    }
    return false;
}

function deleteMessage(messageId) {
    const before = chatHistory.length;
    chatHistory = chatHistory.filter(m => m.id !== messageId);
    const deleted = chatHistory.length < before;
    if (deleted) {
        saveHistory();
        if (ioInstance) ioInstance.emit('chat_delete', { id: messageId });
        log.info(`Deleted message: ${messageId}`);
    }
    return deleted;
}

function broadcastMessage(message) {
    if (ioInstance) ioInstance.emit('chat_message', message);
}

// ─── Socket.io ───────────────────────────────────────────────────────────────

function initSocketHandlers(io) {
    ioInstance = io;

    io.on('connection', (socket) => {
        log.info(`Client connected: ${socket.id}`);

        socket.emit('chat_history', chatHistory);

        socket.on('chat_message', (msg) => {
            const message = addMessage(msg);
            io.emit('chat_message', message);
        });

        socket.on('disconnect', () => {
            log.info(`Client disconnected: ${socket.id}`);
        });
    });
}

// Load on module init
loadHistory();

module.exports = {
    loadHistory,
    saveHistory,
    addMessage,
    getHistory,
    deleteMessage,
    broadcastMessage,
    pruneOldMessages,
    initSocketHandlers,
    getIo: () => ioInstance,
    flush,
    CHAT_UPLOADS_DIR,
};
