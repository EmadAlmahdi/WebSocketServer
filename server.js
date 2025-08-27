import { Server } from 'socket.io';
import http from 'http';
import { createLogger, format, transports } from 'winston';

/**
 * Socket.IO server for real-time user tracking and chat functionality
 * @class RealTimeServer
 * @description Handles user sessions, real-time messaging, and user presence tracking
 */

// Configure logger
const logger = createLogger({
    level: process.env.LOG_LEVEL || 'debug',
    format: format.combine(
        format.timestamp(),
        format.errors({ stack: true }),
        format.json()
    ),
    defaultMeta: { service: 'socketio-server' },
    transports: [
        new transports.Console({
            format: format.combine(
                format.colorize(),
                format.simple()
            )
        }),
        new transports.File({ filename: 'logs/error.log', level: 'error' }),
        new transports.File({ filename: 'logs/combined.log' })
    ]
});

// Create HTTP server
const server = http.createServer();
const io = new Server(server, {
    cors: {
        origin: process.env.CORS_ORIGIN || '*',
        methods: ['GET', 'POST'],
        credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000
});

// Global state
let userCount = 0;
const sessions = {};
const messageHistory = [];
const MAX_MESSAGE_HISTORY = 100;

/**
 * Utility function to validate user input
 * @param {string} input - Input to validate
 * @returns {boolean} - True if input is valid
 */
const isValidInput = (input) => {
    return typeof input === 'string' && input.trim().length > 0 && input.length <= 100;
};

/**
 * Update user count and broadcast user list to all clients
 * @function updateCountAndList
 */
const updateCountAndList = () => {
    const userList = Object.entries(sessions).map(([username, sessionList]) => ({
        username: username,
        fullName: sessionList[0]?.fullName || 'Unknown',
        sessions: sessionList.map(session => ({
            id: session.id,
            loginTime: session.loginTime,
            lastSeen: session.lastSeen,
            url: session.url,
            userAgent: session.userAgent,
            isOnline: true
        })),
        isOnline: true
    }));

    io.emit('userList', userList);
    io.emit('userCount', userCount);

    logger.debug('User list updated', { userCount, users: Object.keys(sessions) });
};

/**
 * Handle user connection events
 */
io.on('connection', socket => {
    logger.info('Client connected', { socketId: socket.id });

    // Send connection acknowledgement
    socket.emit('connected', {
        message: 'Successfully connected to server',
        socketId: socket.id,
        serverTime: new Date().toISOString()
    });

    // Send initial message history
    socket.emit('messageHistory', messageHistory.slice(-20));

    /**
     * Handle incoming messages from clients
     * @event message
     * @param {Object} data - Message data
     */
    socket.on('message', (data) => {
        logger.debug('Received message', { socketId: socket.id, data });

        // Validate message data
        if (!data || typeof data !== 'object') {
            logger.warn('Invalid message format', { socketId: socket.id, data });
            return socket.emit('error', { message: 'Invalid message format' });
        }

        // Add to message history
        const messageData = {
            ...data,
            timestamp: new Date().toISOString(),
            socketId: socket.id
        };

        messageHistory.push(messageData);

        // Maintain message history size
        if (messageHistory.length > MAX_MESSAGE_HISTORY) {
            messageHistory.shift();
        }

        // Broadcast to all clients
        io.emit('newMessage', messageData);

        // Send acknowledgement
        socket.emit('messageReceived', {
            status: 'success',
            message: 'Message received!',
            timestamp: new Date().toISOString()
        });
    });

    /**
     * Handle user login events
     * @event login
     * @param {string} username - User's username
     * @param {string} fullName - User's full name
     * @param {string} url - Current page URL
     * @param {string} userAgent - User's browser/device info
     */
    socket.on("login", (username, fullName, url, userAgent) => {
        logger.info('Login attempt', { socketId: socket.id, username });

        // Validate input
        if (!isValidInput(username) || !isValidInput(fullName)) {
            logger.warn('Invalid login data', { socketId: socket.id, username, fullName });
            return socket.emit('loginError', { message: 'Invalid username or full name' });
        }

        if (!sessions[username]) {
            sessions[username] = [];
            userCount++;
            logger.info('New user registered', { username, userCount });
        }

        const sessionData = {
            fullName: fullName.trim(),
            id: socket.id,
            loginTime: Date.now(),
            lastSeen: Date.now(),
            url: url || 'Unknown',
            userAgent: userAgent || 'Unknown',
        };

        sessions[username].push(sessionData);

        // Associate socket with username
        socket.username = username;

        logger.info('User logged in', { username, socketId: socket.id });

        socket.emit('loginSuccess', {
            message: 'Login successful',
            username,
            sessionId: socket.id
        });

        updateCountAndList();
    });

    /**
     * Handle typing indicators
     * @event typing
     * @param {Object} data - Typing data
     */
    socket.on('typing', ({ person, typing }) => {
        if (!socket.username) {
            return socket.emit('error', { message: 'Not authenticated' });
        }

        logger.debug('Typing event', { from: socket.username, person, typing });

        // Broadcast typing status to other users
        socket.broadcast.emit('typing', {
            person: socket.username,
            typing,
            timestamp: new Date().toISOString()
        });
    });

    /**
     * Handle chat messages
     * @event chatMessage
     * @param {Object} data - Message data
     * @param {Function} callback - Acknowledgement callback
     */
    socket.on('chatMessage', (data, callback) => {
        if (!socket.username) {
            return callback({ success: false, error: 'Not authenticated' });
        }

        const { person, message } = data;

        // Validate message
        if (!isValidInput(message)) {
            return callback({ success: false, error: 'Invalid message' });
        }

        logger.info('Chat message sent', { from: socket.username, to: person, message });

        if (sessions[person]) {
            const messagePayload = {
                from: socket.username,
                message: message.trim(),
                timestamp: new Date().toISOString(),
                type: 'direct'
            };

            // Send to target user
            sessions[person].forEach(session => {
                io.to(session.id).emit('chatResponse', messagePayload);
            });

            // Also send to sender for confirmation
            socket.emit('chatResponse', { ...messagePayload, self: true });

            callback({ success: true, timestamp: new Date().toISOString() });
        } else {
            logger.warn('User not found for chat message', { target: person });
            callback({ success: false, error: `User ${person} is not available` });
        }
    });

    /**
     * Handle user status updates
     * @event updateStatus
     * @param {string} status - New status message
     */
    socket.on('updateStatus', (status) => {
        if (!socket.username) return;

        if (sessions[socket.username]) {
            sessions[socket.username].forEach(session => {
                if (session.id === socket.id) {
                    session.status = status;
                    session.lastSeen = Date.now();
                }
            });

            logger.debug('Status updated', { username: socket.username, status });
            updateCountAndList();
        }
    });

    /**
     * Handle user disconnection
     * @event disconnect
     */
    socket.on('disconnect', (reason) => {
        logger.info('Client disconnected', {
            socketId: socket.id,
            username: socket.username,
            reason
        });

        if (socket.username && sessions[socket.username]) {
            const sessionList = sessions[socket.username];
            const sessionIndex = sessionList.findIndex(session => session.id === socket.id);

            if (sessionIndex !== -1) {
                // Mark as offline but keep in sessions for history
                sessionList[sessionIndex].lastSeen = Date.now();
                sessionList[sessionIndex].isOnline = false;

                // Remove if no active sessions
                const hasActiveSessions = sessionList.some(s => s.isOnline);
                if (!hasActiveSessions) {
                    delete sessions[socket.username];
                    userCount--;
                    logger.info('User completely offline', { username: socket.username });
                }
            }
        }

        updateCountAndList();
    });

    /**
     * Handle connection errors
     */
    socket.on('error', (error) => {
        logger.error('Socket error', { socketId: socket.id, error });
    });
});

// Add graceful shutdown handling
const gracefulShutdown = (signal) => {
    logger.info(`Received ${signal}, shutting down gracefully`);

    // Notify all clients
    io.emit('serverMaintenance', {
        message: 'Server is shutting down for maintenance',
        restartTime: '2 minutes'
    });

    setTimeout(() => {
        server.close(() => {
            logger.info('HTTP server closed');
            process.exit(0);
        });
    }, 2000);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    logger.info(`Server is running on port: ${PORT}`);
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Export for testing
export { io, server, sessions, updateCountAndList };