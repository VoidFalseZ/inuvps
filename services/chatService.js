// services/chatService.js - Chat history management

const fs = require('fs');
const path = require('path');
const config = require('../config');

const CACHE_DIR = path.join(process.cwd(), 'cache');
const CHAT_HISTORY_FILE = path.join(CACHE_DIR, 'chat_history.json');
const CHAT_UPLOADS_DIR = path.join(CACHE_DIR, 'chat_uploads');

// Ensure directories exist
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(CHAT_UPLOADS_DIR)) fs.mkdirSync(CHAT_UPLOADS_DIR, { recursive: true });

// In-memory chat history
let chatHistory = [];

// Socket.io instance (set during init)
let _io = null;

/**
 * Load chat history from file
 */
function loadHistory() {
    try {
        if (fs.existsSync(CHAT_HISTORY_FILE)) {
            chatHistory = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf8'));
            const oneDayAgo = Date.now() - config.CHAT.MAX_AGE_MS;
            chatHistory = chatHistory.filter(msg => new Date(msg.timestamp).getTime() > oneDayAgo);
            console.log(`[Chat] Loaded ${chatHistory.length} messages from history`);
        }
    } catch (error) {
        console.error('[Chat] Error loading history:', error.message);
        chatHistory = [];
    }
}

/**
 * Save chat history to file
 */
function saveHistory() {
    try {
        if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chatHistory, null, 2));
    } catch (error) {
        console.error('[Chat] Error saving history:', error.message);
    }
}

/**
 * Add a message to chat history
 * @param {Object} msg - Message object
 * @returns {Object} The message with timestamp
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

/**
 * Delete a message by ID
 * @param {string} id - Message ID
 * @returns {boolean} True if deleted, false if not found
 */
function deleteMessage(id) {
    const initialLength = chatHistory.length;
    chatHistory = chatHistory.filter(m => m.id !== id);
    if (chatHistory.length < initialLength) {
        saveHistory();
        // Broadcast deletion to all connected clients
        if (_io) {
            _io.emit('chat_delete', { id });
        }
        return true;
    }
    return false;
}

/**
 * Get the socket.io instance
 * @returns {Server|null}
 */
function getIo() {
    return _io;
}

/**
 * Get current chat history
 * @returns {Array} Chat messages
 */
function getHistory() {
    return chatHistory;
}

/**
 * Prune old messages (for periodic cleanup)
 */
function pruneOldMessages() {
    const oneDayAgo = Date.now() - config.CHAT.MAX_AGE_MS;
    const hadOld = chatHistory.some(m => new Date(m.timestamp).getTime() < oneDayAgo);

    if (hadOld) {
        chatHistory = chatHistory.filter(m => new Date(m.timestamp).getTime() > oneDayAgo);
        saveHistory();
        console.log('[Chat] Pruned old messages');
        return true;
    }
    return false;
}

/**
 * Initialize Socket.io handlers for chat
 * @param {Server} io - Socket.io server instance
 */
function initSocketHandlers(io) {
    _io = io; // Store io instance for admin broadcasts

    io.on('connection', (socket) => {
        console.log('[Socket] Client connected:', socket.id);

        // Send existing history to the connected client
        socket.emit('chat_history', chatHistory);

        socket.on('chat_message', (msg) => {
            const message = addMessage(msg);
            // Broadcast to all clients (including sender to confirm receipt)
            io.emit('chat_message', message);
        });

        socket.on('disconnect', () => {
            console.log('[Socket] Client disconnected:', socket.id);
        });
    });
}

// Load history on module init
loadHistory();

module.exports = {
    loadHistory,
    saveHistory,
    addMessage,
    deleteMessage,
    getHistory,
    pruneOldMessages,
    initSocketHandlers,
    getIo,
    CHAT_UPLOADS_DIR
};
