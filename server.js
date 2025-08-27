import { Server } from 'socket.io';
import http from 'http';

// Skapa en HTTP-server
const server = http.createServer();
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

let userCount = 0;
const sessions = {};

io.on('connection', socket => {
    socket.on('message', (data) => {
        console.log('Received message from PHP client:', data);
        // Optionally, send a response back to the PHP client
        socket.emit('messageReceived', { status: 'success', message: 'Message received!' });
    });

    // Lyssna på 'login' eventet för att registrera användaren
    socket.on("login", (username, fullName, url, userAgent) => {
        if (!sessions[username]) {
            sessions[username] = [];
            userCount++;
        }

        sessions[username].push({
            fullName: fullName,
            id: socket.id,
            loginTime: Date.now(),
            url: url,
            userAgent: userAgent,
        });

        updateCountAndList();
    });

    socket.on('typing', ({ person, typing }) => {
        // Skicka 'typing' status till andra användare
        socket.broadcast.emit('typing', { person, typing });
    });

    socket.on('chatMessage', (data, callback) => {
        const { person, message } = data;

        if (sessions[person]) {
            sessions[person].forEach(session => {
                io.to(session.id).emit('chatResponse', {
                    person,
                    message,
                    timestamp: new Date().toISOString()
                });
            });
            callback({ success: true });
        } else {
            callback({ success: false, error: `User not available ${person}` });
        }
    });

    socket.on('disconnect', () => {
        let username = null;

        // Hitta användaren och ta bort sessionen
        for (const [user, sessionList] of Object.entries(sessions)) {
            const sessionIndex = sessionList.findIndex(session => session.id === socket.id);
            if (sessionIndex !== -1) {
                username = user;
                sessionList.splice(sessionIndex, 1);
                if (sessionList.length === 0) {
                    delete sessions[username];
                    userCount--;
                }
                break;
            }
        }

        updateCountAndList();
    });
});

const updateCountAndList = () => {
    const userList = Object.entries(sessions).map(([username, sessionList]) => ({
        fullName: sessionList[0].fullName,
        id: username,
        sessions: sessionList.map(session => ({
            id: session.id,
            loginTime: session.loginTime,
            url: session.url,
            userAgent: session.userAgent,
        })),
    }));

    io.emit('userList', userList);
    io.emit('userCount', userCount);
};

// Starta servern på port 3000
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});